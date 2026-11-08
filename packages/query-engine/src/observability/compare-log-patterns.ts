import { Effect, Array as Arr, Order, Record as Rec, Result, String as Str } from "effect"
import type { ListLogsOutput } from "@maple/domain/tinybird"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type {
	CompareLogPatternsInput,
	CompareLogPatternsOutput,
	LogPatternChange,
	LogPatternDiff,
} from "./types"
import {
	incrementCount,
	makeLogTemplateMiner,
	mapToObject,
	type ClusterableLogRow,
} from "./mine-log-patterns"
import { rowText } from "../row-text"

const DEFAULT_SAMPLE_SIZE = 5_000
const DEFAULT_LIMIT = 30
/** Fewer occurrences than this on the busier side is noise, whatever the ratio. */
export const MIN_PATTERN_COUNT = 5
/** A share has to at least double (or halve) to count as up (or down). */
const MIN_RATIO = 2
/** Two-proportion z-score a change needs, so a 6-vs-2 sampling wobble is not a regression. */
const MIN_Z = 3

export interface LogPatternWindow {
	readonly rows: ReadonlyArray<ClusterableLogRow>
	/** Every log in the window, not only the sampled ones: scales sample counts to estimates. */
	readonly total: number
}

const ERROR_SEVERITIES = new Set(["ERROR", "FATAL", "CRITICAL", "EMERGENCY", "ALERT", "ERR"])

/** True when any of the template's logs carried an error-level severity, in any SDK spelling. */
export const hasErrorSeverity = (severityCounts: { readonly [key: string]: number }): boolean =>
	Arr.some(Rec.keys(severityCounts), (k) => ERROR_SEVERITIES.has(Str.toUpperCase(k)))

interface Cluster {
	template: string
	sample: string
	before: number
	after: number
	severityCounts: Map<string, number>
	serviceCounts: Map<string, number>
}

const zScore = (a: number, nA: number, b: number, nB: number): number => {
	const pooled = (a + b) / (nA + nB)
	const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB))
	return se === 0 ? 0 : (a / nA - b / nB) / se
}

const classify = (
	c: Cluster,
	nBefore: number,
	nAfter: number,
): { change: LogPatternChange; ratio?: number; z: number } | undefined => {
	if (Math.max(c.before, c.after) < MIN_PATTERN_COUNT) return undefined
	const z = zScore(c.after, nAfter, c.before, nBefore)
	if (Math.abs(z) < MIN_Z) return undefined
	if (c.before === 0) return { change: "new", z }
	if (c.after === 0) return { change: "gone", z }
	const ratio = c.after / nAfter / (c.before / nBefore)
	if (ratio >= MIN_RATIO) return { change: "up", ratio, z }
	if (ratio <= 1 / MIN_RATIO) return { change: "down", ratio, z }
	return undefined
}

/** Emerging errors first, then anything emerging, then what faded; strongest change first in each. */
const rank = (d: LogPatternDiff & { readonly z: number }): number =>
	d.change === "new" || d.change === "up" ? (hasErrorSeverity(d.severityCounts) ? 0 : 1) : 2

const byRank = Order.combine(
	Order.mapInput(Order.Number, rank),
	Order.mapInput(Order.Number, (d: { readonly z: number }) => -Math.abs(d.z)),
)

/**
 * The templates whose share of the logs changed between two windows.
 *
 * Both samples go through one Drain miner, so a template means the same thing on both
 * sides; mining each window alone yields templates that differ by a masked token and
 * never match. Changes compare each template's share of its window's sample, which
 * holds steady when traffic or the window length changes; estimates scale that share
 * by the window's real log count.
 */
export const diffLogPatterns = (
	before: LogPatternWindow,
	after: LogPatternWindow,
	limit: number = DEFAULT_LIMIT,
): { patterns: LogPatternDiff[]; unchanged: number; sampledBefore: number; sampledAfter: number } => {
	const miner = makeLogTemplateMiner()
	const clusters = new Map<number, Cluster>()
	const sampled = { before: 0, after: 0 }

	const add = (row: ClusterableLogRow, side: "before" | "after") => {
		const body = rowText(row.body)
		if (body.length === 0) return
		sampled[side] += 1
		const mined = miner.addLogMessage(body)
		const cluster = clusters.get(mined.clusterId) ?? {
			template: mined.templateMined,
			sample: body,
			before: 0,
			after: 0,
			severityCounts: new Map<string, number>(),
			serviceCounts: new Map<string, number>(),
		}
		cluster.template = mined.templateMined
		cluster[side] += 1
		// The sample shows the side that defines the change: a new template's first log, not an old one.
		if (side === "after" && cluster.after === 1) cluster.sample = body
		incrementCount(cluster.severityCounts, rowText(row.severityText, "UNKNOWN"))
		incrementCount(cluster.serviceCounts, rowText(row.serviceName, "unknown"))
		clusters.set(mined.clusterId, cluster)
	}
	for (const row of before.rows) add(row, "before")
	for (const row of after.rows) add(row, "after")

	if (sampled.before === 0 || sampled.after === 0) {
		return {
			patterns: [],
			unchanged: clusters.size,
			sampledBefore: sampled.before,
			sampledAfter: sampled.after,
		}
	}

	// The count query can trail the sample by a few late rows; never estimate below what was read.
	const totalBefore = Math.max(before.total, sampled.before)
	const totalAfter = Math.max(after.total, sampled.after)
	const estimate = (count: number, n: number, total: number) => Math.round((count / n) * total)

	const changed = Arr.filterMap(Array.from(clusters.values()), (c) => {
		const verdict = classify(c, sampled.before, sampled.after)
		if (verdict === undefined) return Result.failVoid
		return Result.succeed({
			template: c.template,
			sample: c.sample,
			change: verdict.change,
			before: { sampled: c.before, estimated: estimate(c.before, sampled.before, totalBefore) },
			after: { sampled: c.after, estimated: estimate(c.after, sampled.after, totalAfter) },
			...(verdict.ratio === undefined ? undefined : { ratio: Math.round(verdict.ratio * 100) / 100 }),
			severityCounts: mapToObject(c.severityCounts),
			serviceCounts: mapToObject(c.serviceCounts),
			z: verdict.z,
		})
	})

	const patterns = Arr.map(Arr.take(Arr.sort(changed, byRank), limit), ({ z: _z, ...diff }) => diff)
	return {
		patterns,
		unchanged: clusters.size - changed.length,
		sampledBefore: sampled.before,
		sampledAfter: sampled.after,
	}
}

/**
 * What changed in the logs between two windows, e.g. the hour before a deploy and the hour after.
 *
 * Reads a recent sample and the total count of each window (four queries, in parallel), then
 * diffs the templates in process. Memory is O(2 × sampleSize).
 */
export const compareLogPatterns = Effect.fn("Observability.compareLogPatterns")(function* (
	input: CompareLogPatternsInput,
) {
	const executor = yield* WarehouseExecutor
	const sampleSize = input.sampleSize ?? DEFAULT_SAMPLE_SIZE
	const filters = {
		...(input.service && { service: input.service }),
		...(input.severity && { severity: input.severity }),
		...(input.search && { search: input.search }),
		...(input.environment && { deployment_env: input.environment }),
	}
	const window = (range: CompareLogPatternsInput["before"]) => ({
		start_time: range.startTime,
		end_time: range.endTime,
		...filters,
	})

	const [beforeRows, afterRows, beforeCount, afterCount] = yield* Effect.all(
		[
			executor.query<ListLogsOutput>(
				"list_logs",
				{ ...window(input.before), limit: sampleSize },
				{ profile: "list" },
			),
			executor.query<ListLogsOutput>(
				"list_logs",
				{ ...window(input.after), limit: sampleSize },
				{ profile: "list" },
			),
			executor.query<{ readonly total: number | string }>("logs_count", window(input.before), {
				profile: "aggregation",
			}),
			executor.query<{ readonly total: number | string }>("logs_count", window(input.after), {
				profile: "aggregation",
			}),
		],
		{ concurrency: "unbounded" },
	)

	const totalOf = (rows: ReadonlyArray<{ readonly total: number | string }>) => Number(rows[0]?.total ?? 0)
	const totals = { before: totalOf(beforeCount.data), after: totalOf(afterCount.data) }
	const diff = diffLogPatterns(
		{ rows: beforeRows.data, total: totals.before },
		{ rows: afterRows.data, total: totals.after },
		input.limit ?? DEFAULT_LIMIT,
	)

	yield* Effect.annotateCurrentSpan({
		"result.sampledBefore": diff.sampledBefore,
		"result.sampledAfter": diff.sampledAfter,
		"result.changedCount": diff.patterns.length,
		"result.unchangedCount": diff.unchanged,
	})

	return {
		before: { timeRange: input.before, totalLogs: totals.before, sampled: diff.sampledBefore },
		after: { timeRange: input.after, totalLogs: totals.after, sampled: diff.sampledAfter },
		sampleSize,
		patterns: diff.patterns,
		unchanged: diff.unchanged,
	} satisfies CompareLogPatternsOutput
})
