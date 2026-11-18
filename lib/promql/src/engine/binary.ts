import { lookup } from "../lookup"
import { Result } from "effect"
import type { BinaryOp, VectorMatching } from "../ast"
import { COMPARISON_OPS, SET_OPS } from "../ast"
import {
	dropMetricName,
	ensureUniqueLabelsets,
	type EvalError,
	evalError,
	labelsKey,
	labelsString,
	makeLabels,
	matchLabels,
	METRIC_NAME,
	signature,
} from "./labels"
import type { InstantVector, Labels, Sample } from "./types"

/** Go's math.Pow, which differs from JS `**` for a base of 1 or -1 with an infinite or NaN exponent. */
const goPow = (x: number, y: number): number => {
	if (y === 0 || x === 1) return 1
	if (x === -1 && (y === Infinity || y === -Infinity)) return 1
	return x ** y
}

/** Go's math.Mod: the sign follows the dividend, like JS `%`. */
const arithmetic = (op: BinaryOp, lhs: number, rhs: number): number | undefined => {
	switch (op) {
		case "+":
			return lhs + rhs
		case "-":
			return lhs - rhs
		case "*":
			return lhs * rhs
		case "/":
			return lhs / rhs
		case "%":
			return lhs % rhs
		case "^":
			return goPow(lhs, rhs)
		case "atan2":
			return Math.atan2(lhs, rhs)
		default:
			return undefined
	}
}

const compare = (op: BinaryOp, lhs: number, rhs: number): boolean => {
	switch (op) {
		case "==":
			return lhs === rhs
		case "!=":
			return lhs !== rhs
		case ">":
			return lhs > rhs
		case "<":
			return lhs < rhs
		case ">=":
			return lhs >= rhs
		case "<=":
			return lhs <= rhs
		default:
			return false
	}
}

const isComparison = (op: BinaryOp): boolean => COMPARISON_OPS.has(op)

/** Prometheus' scalarBinop: comparisons between scalars always yield 0 or 1 (bool is required by the parser). */
export const scalarBinary = (op: BinaryOp, lhs: number, rhs: number, _returnBool: boolean): number =>
	isComparison(op) ? (compare(op, lhs, rhs) ? 1 : 0) : (arithmetic(op, lhs, rhs) ?? Number.NaN)

/** Prometheus' vectorElemBinop for floats: the value and whether the sample is kept. */
const elemBinop = (
	op: BinaryOp,
	lhs: number,
	rhs: number,
): { readonly value: number; readonly keep: boolean } => {
	if (isComparison(op)) return { value: lhs, keep: compare(op, lhs, rhs) }
	const value = arithmetic(op, lhs, rhs)
	return value === undefined ? { value: lhs, keep: false } : { value, keep: true }
}

export const vectorScalarBinary = (
	op: BinaryOp,
	vector: InstantVector,
	scalar: number,
	scalarOnLeft: boolean,
	returnBool: boolean,
	evalTimeMs: number,
): InstantVector => {
	if (SET_OPS.has(op)) return []
	const out: Sample[] = []
	for (const sample of vector) {
		const [lhs, rhs] = scalarOnLeft ? [scalar, sample.value] : [sample.value, scalar]
		const result = elemBinop(op, lhs, rhs)
		// A filtering comparison keeps the vector's own value even when the scalar is on the left.
		let value = isComparison(op) && scalarOnLeft ? rhs : result.value
		let keep = result.keep
		if (returnBool) {
			value = keep ? 1 : 0
			keep = true
		}
		if (!keep) continue
		const labels = returnBool || !isComparison(op) ? dropMetricName(sample.labels) : sample.labels
		out.push({ labels, value, t: evalTimeMs })
	}
	return out
}

const defaultMatching = (op: BinaryOp): VectorMatching => ({
	card: SET_OPS.has(op) ? "many-to-many" : "one-to-one",
	on: false,
	labels: [],
	include: [],
})

const signatures = (vector: InstantVector, matching: VectorMatching): ReadonlyArray<string> =>
	vector.map((s) => signature(s.labels, matching.labels, matching.on))

const setOp = (
	op: BinaryOp,
	lhs: InstantVector,
	rhs: InstantVector,
	matching: VectorMatching,
): InstantVector => {
	const lhsSigs = signatures(lhs, matching)
	const rhsSigs = signatures(rhs, matching)
	const rhsSet = new Set(rhsSigs)
	switch (op) {
		case "and":
			return lhs.filter((_, i) => rhsSet.has(lhsSigs[i] ?? ""))
		case "unless":
			return lhs.filter((_, i) => !rhsSet.has(lhsSigs[i] ?? ""))
		default: {
			const lhsSet = new Set(lhsSigs)
			return [...lhs, ...rhs.filter((_, j) => !lhsSet.has(rhsSigs[j] ?? ""))]
		}
	}
}

/** Prometheus' resultMetric: start from the "many" side, then apply matching and include labels from the "one" side. */
const resultMetric = (
	many: Labels,
	one: Labels,
	op: BinaryOp,
	matching: VectorMatching,
	returnBool: boolean,
): Labels => {
	const names = new Set(matching.labels)
	const out = new Map(Object.entries(many))
	if (!isComparison(op)) out.delete(METRIC_NAME)
	if (matching.card === "one-to-one") {
		for (const name of out.keys()) {
			if (names.has(name) !== matching.on) out.delete(name)
		}
	}
	for (const name of matching.include) {
		const value = lookup(one, name)
		if (value === undefined || value === "") out.delete(name)
		else out.set(name, value)
	}
	// VectorBinop drops the name for `bool` after resultMetric, so a copied __name__ goes too.
	if (returnBool) out.delete(METRIC_NAME)
	return makeLabels(out)
}

const duplicateError = (matching: VectorMatching, a: Sample, b: Sample): EvalError => {
	const side = matching.card === "one-to-many" ? "left" : "right"
	const group = labelsString(matchLabels(a.labels, matching.labels, matching.on))
	const [d1, d2] = [labelsString(a.labels), labelsString(b.labels)].sort()
	return evalError(
		`found duplicate series for the match group ${group} on the ${side} hand-side of the operation: [${d1}, ${d2}]` +
			";many-to-many matching not allowed: matching labels must be unique on one side",
	)
}

export const vectorVectorBinary = (
	op: BinaryOp,
	lhs: InstantVector,
	rhs: InstantVector,
	matching: VectorMatching | undefined,
	returnBool: boolean,
	evalTimeMs: number,
): Result.Result<InstantVector, EvalError> => {
	const base = matching ?? defaultMatching(op)
	if (SET_OPS.has(op)) {
		const m: VectorMatching = { ...base, card: "many-to-many" }
		return Result.succeed(setOp(op, lhs, rhs, m).map((s) => ({ ...s, t: evalTimeMs })))
	}
	if (lhs.length === 0 || rhs.length === 0) return Result.succeed([])
	const m: VectorMatching = base.card === "many-to-many" ? { ...base, card: "one-to-one" } : base
	const swap = m.card === "one-to-many"
	const [many, one] = swap ? [rhs, lhs] : [lhs, rhs]

	const oneBySig = new Map<string, Sample>()
	for (const sample of one) {
		const sig = signature(sample.labels, m.labels, m.on)
		const existing = oneBySig.get(sig)
		if (existing !== undefined) return Result.fail(duplicateError(m, sample, existing))
		oneBySig.set(sig, sample)
	}

	const matchedOneToOne = new Set<string>()
	const matchedMetrics = new Map<string, Set<string>>()
	const out: Sample[] = []
	for (const ls of many) {
		const sig = signature(ls.labels, m.labels, m.on)
		const rs = oneBySig.get(sig)
		if (rs === undefined) continue
		const [fl, fr] = swap ? [rs.value, ls.value] : [ls.value, rs.value]
		const result = elemBinop(op, fl, fr)
		// A filtered-out comparison is not a match, as in Prometheus' VectorBinop.
		if (!result.keep && !returnBool) continue
		const value = returnBool ? (result.keep ? 1 : 0) : result.value
		const labels = resultMetric(ls.labels, rs.labels, op, m, returnBool)
		if (m.card === "one-to-one") {
			if (matchedOneToOne.has(sig)) {
				return Result.fail(
					evalError(
						"multiple matches for labels: many-to-one matching must be explicit (group_left/group_right)",
					),
				)
			}
			matchedOneToOne.add(sig)
		} else {
			const inserted = matchedMetrics.get(sig) ?? new Set<string>()
			const key = labelsKey(labels)
			if (inserted.has(key)) {
				return Result.fail(
					evalError("multiple matches for labels: grouping labels must ensure unique matches"),
				)
			}
			inserted.add(key)
			matchedMetrics.set(sig, inserted)
		}
		out.push({ labels, value, t: evalTimeMs })
	}
	return ensureUniqueLabelsets(out)
}
