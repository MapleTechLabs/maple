import { Effect, Array as Arr, Order, Result } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"
import { zScore, MIN_COUNT, MIN_RATIO, MIN_Z } from "./significance"
import type { CompareOperationsInput, CompareOperationsOutput, OperationChange, OperationFlag } from "./types"

/** Operations read per window; the busiest first, so a window at the cap can hide rare ones. */
const OPERATIONS_PER_WINDOW = 1_000
const DEFAULT_LIMIT = 30
/** p95 has to move by half again, and by at least this much, to count as slower or faster. */
const LATENCY_RATIO = 1.5
const LATENCY_MIN_DELTA_MS = 5
/** Spans needed on both sides before a p95 is worth comparing. */
const LATENCY_MIN_SPANS = 20

export interface OperationWindowRow {
	readonly spanName: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly p95DurationMs: number
}

type Totals = { readonly spans: number; readonly estimated: number }
type Absent = { readonly before: boolean; readonly after: boolean }

const FLAG_RANK = {
	errors_up: 0,
	new: 1,
	slower: 2,
	volume_up: 3,
	errors_down: 4,
	gone: 5,
	volume_down: 6,
	faster: 7,
} as const satisfies Record<OperationFlag, number>

const byRank = Order.combine(
	Order.mapInput(Order.Number, (c: OperationChange) => Math.min(...Arr.map(c.flags, (f) => FLAG_RANK[f]))),
	Order.mapInput(Order.Number, (c: OperationChange) => -(c.after.spans + c.before.spans)),
)

// Significance is tested on the span rows actually stored; ratios use sampling-weighted counts,
// so a sampler change across the deploy does not read as a traffic or error change.
const volumeFlag = (
	before: OperationWindowRow | undefined,
	after: OperationWindowRow | undefined,
	nB: Totals,
	nA: Totals,
	absent: Absent,
): OperationFlag | undefined => {
	const a = after?.spanCount ?? 0
	const b = before?.spanCount ?? 0
	if (Math.max(a, b) < MIN_COUNT || Math.abs(zScore(a, nA.spans, b, nB.spans)) < MIN_Z) return undefined
	// An operation missing from a window cut at the cap may just have ranked below the cut.
	if (before === undefined) return absent.before ? undefined : "new"
	if (after === undefined) return absent.after ? undefined : "gone"
	const ratio = after.estimatedSpanCount / nA.estimated / (before.estimatedSpanCount / nB.estimated)
	return ratio >= MIN_RATIO ? "volume_up" : ratio <= 1 / MIN_RATIO ? "volume_down" : undefined
}

const weightedErrorRate = (row: OperationWindowRow | undefined) =>
	row !== undefined && row.estimatedSpanCount > 0 ? row.estimatedErrorCount / row.estimatedSpanCount : 0

const errorFlag = (
	before: OperationWindowRow | undefined,
	after: OperationWindowRow | undefined,
	absent: Absent,
) => {
	const eb = before?.errorCount ?? 0
	const ea = after?.errorCount ?? 0
	const b = before?.spanCount ?? 0
	const a = after?.spanCount ?? 0
	if (a === 0 || Math.max(ea, eb) < MIN_COUNT) return undefined
	// A new operation that fails is an emerging error even without a baseline, unless the
	// baseline was cut at the cap and may simply not list it.
	if (b === 0) return ea >= MIN_COUNT && !absent.before ? "errors_up" : undefined
	if (Math.abs(zScore(ea, a, eb, b)) < MIN_Z) return undefined
	const rateB = weightedErrorRate(before)
	const ratio = rateB === 0 ? Infinity : weightedErrorRate(after) / rateB
	return ratio >= MIN_RATIO ? "errors_up" : ratio <= 1 / MIN_RATIO ? "errors_down" : undefined
}

const latencyFlag = (before: OperationWindowRow | undefined, after: OperationWindowRow | undefined) => {
	if (before === undefined || after === undefined) return undefined
	if (before.spanCount < LATENCY_MIN_SPANS || after.spanCount < LATENCY_MIN_SPANS) return undefined
	const delta = after.p95DurationMs - before.p95DurationMs
	if (Math.abs(delta) < LATENCY_MIN_DELTA_MS || before.p95DurationMs <= 0) return undefined
	const ratio = after.p95DurationMs / before.p95DurationMs
	return ratio >= LATENCY_RATIO ? "slower" : ratio <= 1 / LATENCY_RATIO ? "faster" : undefined
}

const side = (row: OperationWindowRow | undefined) => ({
	spans: Math.round(row?.estimatedSpanCount ?? 0),
	errorRate: weightedErrorRate(row),
	p95Ms: row?.p95DurationMs ?? 0,
})

/**
 * The operations of one service whose volume share, error rate or p95 changed between two
 * windows. Volume compares each operation's share of the service's spans, so a traffic rise
 * alone flags nothing; errors compare each operation's own error rate.
 */
export const diffOperations = (
	before: ReadonlyArray<OperationWindowRow>,
	after: ReadonlyArray<OperationWindowRow>,
	opts: { readonly limit?: number; readonly perWindowCap?: number } = {},
): { readonly operations: OperationChange[]; readonly unchanged: number } => {
	const cap = opts.perWindowCap ?? OPERATIONS_PER_WINDOW
	const absentUnknown = { before: before.length >= cap, after: after.length >= cap }
	const totals = (rows: ReadonlyArray<OperationWindowRow>): Totals => ({
		spans: Arr.reduce(rows, 0, (n, r) => n + r.spanCount),
		estimated: Arr.reduce(rows, 0, (n, r) => n + r.estimatedSpanCount),
	})
	const nB = totals(before)
	const nA = totals(after)
	const beforeByName = new Map(Arr.map(before, (r) => [r.spanName, r] as const))
	const afterByName = new Map(Arr.map(after, (r) => [r.spanName, r] as const))
	const names = Arr.dedupe([...beforeByName.keys(), ...afterByName.keys()])

	if (nB.spans === 0 || nA.spans === 0) return { operations: [], unchanged: names.length }

	const changed = Arr.filterMap(names, (name) => {
		const b = beforeByName.get(name)
		const a = afterByName.get(name)
		const flags = Arr.filter(
			[volumeFlag(b, a, nB, nA, absentUnknown), errorFlag(b, a, absentUnknown), latencyFlag(b, a)],
			(f): f is OperationFlag => f !== undefined,
		)
		return flags.length === 0
			? Result.failVoid
			: Result.succeed({ operation: name, flags, before: side(b), after: side(a) })
	})

	return {
		operations: Arr.take(Arr.sort(changed, byRank), opts.limit ?? DEFAULT_LIMIT),
		unchanged: names.length - changed.length,
	}
}

/** One service's per-operation stats in two windows, diffed. Two rollup reads, in parallel. */
export const compareOperations = Effect.fn("Observability.compareOperations")(function* (
	input: CompareOperationsInput,
) {
	const executor = yield* WarehouseExecutor
	const read = (range: CompareOperationsInput["before"]) =>
		executor.compiledQuery(
			CH.compile(
				CH.serviceOperationsSummaryQuery({
					serviceName: input.service,
					environments: input.environment === undefined ? undefined : [input.environment],
					limit: OPERATIONS_PER_WINDOW,
				}),
				{ orgId: executor.orgId, startTime: range.startTime, endTime: range.endTime },
				{ rowSchema: CH.serviceOperationsSummaryRowSchema },
			),
			{ profile: "aggregation", context: "compareOperations" },
		)
	const [before, after] = yield* Effect.all([read(input.before), read(input.after)], {
		concurrency: "unbounded",
	})
	const diff = diffOperations(before, after, { limit: input.limit })

	yield* Effect.annotateCurrentSpan({
		"result.operationsBefore": before.length,
		"result.operationsAfter": after.length,
		"result.changedCount": diff.operations.length,
	})

	const total = (rows: ReadonlyArray<OperationWindowRow>) =>
		Math.round(Arr.reduce(rows, 0, (n, r) => n + r.estimatedSpanCount))
	return {
		before: { timeRange: input.before, spans: total(before), operations: before.length },
		after: { timeRange: input.after, spans: total(after), operations: after.length },
		operations: diff.operations,
		unchanged: diff.unchanged,
	} satisfies CompareOperationsOutput
})
