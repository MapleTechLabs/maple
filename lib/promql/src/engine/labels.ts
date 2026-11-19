import { Result } from "effect"
import type { InstantVector, Labels } from "./types"

export interface EvalError {
	readonly message: string
}

export const METRIC_NAME = "__name__"

export const evalError = (message: string): EvalError => ({ message })

/** Builds a label set, dropping empty values the way Prometheus' labels.Builder does. */
export const makeLabels = (entries: Iterable<readonly [string, string]>): Labels => {
	// fromEntries defines own properties, so a label called __proto__ stays a label.
	return Object.fromEntries(Array.from(entries).filter(([, value]) => value !== ""))
}

export const dropMetricName = (labels: Labels): Labels => {
	if (!(METRIC_NAME in labels)) return labels
	return makeLabels(Object.entries(labels).filter(([name]) => name !== METRIC_NAME))
}

export const withLabel = (labels: Labels, name: string, value: string): Labels =>
	makeLabels([...Object.entries(labels).filter(([n]) => n !== name), [name, value]])

/** Labels kept to `names` (on=true) or with `names` and __name__ removed (on=false). */
export const matchLabels = (labels: Labels, names: ReadonlyArray<string>, on: boolean): Labels => {
	const set = new Set(names)
	if (!on) set.add(METRIC_NAME)
	return makeLabels(Object.entries(labels).filter(([name]) => set.has(name) === on))
}

/** Canonical string key for a whole label set. */
export const labelsKey = (labels: Labels): string =>
	JSON.stringify(
		Object.entries(labels)
			.filter(([, v]) => v !== "")
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	)

export const signature = (labels: Labels, names: ReadonlyArray<string>, on: boolean): string =>
	labelsKey(matchLabels(labels, names, on))

/** Prometheus' `{a="1", b="2"}` rendering, used in error messages. */
export const labelsString = (labels: Labels): string => {
	const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(", ")}}`
}

/** Prometheus 3 accepts any non-empty valid UTF-8 label name. */
export const isValidLabelName = (name: string): boolean =>
	name.length > 0 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)

/** Prometheus' labels.Compare: by sorted (name, value) pairs, a prefix sorts first. */
export const compareLabels = (a: Labels, b: Labels): number => {
	const ea = Object.entries(a).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
	const eb = Object.entries(b).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
	for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
		const [na, va] = ea[i] ?? ["", ""]
		const [nb, vb] = eb[i] ?? ["", ""]
		if (na !== nb) return na < nb ? -1 : 1
		if (va !== vb) return va < vb ? -1 : 1
	}
	return ea.length - eb.length
}

/** Fails when two samples share a label set, as Prometheus' rangeEval does. */
export const ensureUniqueLabelsets = (vector: InstantVector): Result.Result<InstantVector, EvalError> => {
	const seen = new Set<string>()
	for (const sample of vector) {
		const key = labelsKey(sample.labels)
		if (seen.has(key))
			return Result.fail(evalError("vector cannot contain metrics with the same labelset"))
		seen.add(key)
	}
	return Result.succeed(vector)
}
