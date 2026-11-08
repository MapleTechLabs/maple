import { Effect, Array as Arr, Order, Record as Rec, Result, String as Str } from "effect"
import type { ListLogsOutput } from "@maple/domain/tinybird"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type {
	CompareLogPatternsInput,
	CompareLogPatternsOutput,
	LogPatternChange,
	LogPatternDiff,
} from "./types"
import { MIN_COUNT, MIN_RATIO, MIN_Z, zScore } from "./significance"
import {
	incrementCount,
	makeLogTemplateMiner,
	mapToObject,
	type ClusterableLogRow,
} from "./mine-log-patterns"
import { rowText } from "../row-text"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "../datetime"

const DEFAULT_SAMPLE_SIZE = 5_000
const DEFAULT_LIMIT = 30

/** A sampled log; `timestamp` dates the span of time the sample covers. */
export interface SampledLogRow extends ClusterableLogRow {
	readonly timestamp?: unknown
}

export interface LogPatternWindow {
	readonly rows: ReadonlyArray<SampledLogRow>
	/** Every log in the window, not only the sampled ones: scales sample counts to estimates. */
	readonly total: number
}

const ERROR_SEVERITIES = new Set(["ERROR", "FATAL", "CRITICAL", "EMERGENCY", "ALERT", "ERR"])

const isErrorSeverity = (severity: string): boolean => ERROR_SEVERITIES.has(Str.toUpperCase(severity))

/** True when any of the template's logs carried an error-level severity, in any SDK spelling. */
export const hasErrorSeverity = (severityCounts: { readonly [key: string]: number }): boolean =>
	Arr.some(Rec.keys(severityCounts), isErrorSeverity)

interface Cluster {
	template: string
	sample: string
	before: number
	after: number
	severityCounts: Map<string, number>
	serviceCounts: Map<string, number>
}

interface Side {
	/** Rows read, empty bodies included: the denominator that scales to the window's count. */
	read: number
	/** Rows with a body, clustered: the denominator for shares. */
	sampled: number
	from: string | undefined
	to: string | undefined
}

const classify = (
	c: Cluster,
	nBefore: number,
	nAfter: number,
): { change: LogPatternChange; ratio?: number; z: number } | undefined => {
	if (Math.max(c.before, c.after) < MIN_COUNT) return undefined
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

const coverage = (side: Side) =>
	side.from === undefined || side.to === undefined ? undefined : { startTime: side.from, endTime: side.to }

/**
 * The templates whose share of the logs changed between two windows.
 *
 * Both samples go through the same Drain miners, so a template means the same thing on both
 * sides; mining each window alone yields templates that differ by a masked token and never
 * match. Error-level logs get a miner of their own: Drain would otherwise fold a new
 * `payment failed for order 7` into an old `payment ok for order 7` template and hide it.
 * Changes compare each template's share of its window's sample, which holds steady when
 * traffic or the window length changes; estimates scale that share by the window's log count.
 */
export const diffLogPatterns = (
	before: LogPatternWindow,
	after: LogPatternWindow,
	limit: number = DEFAULT_LIMIT,
) => {
	const miners = { error: makeLogTemplateMiner(), other: makeLogTemplateMiner() }
	const clusters = new Map<string, Cluster>()
	const emptySide = (): Side => ({ read: 0, sampled: 0, from: undefined, to: undefined })
	const sides = { before: emptySide(), after: emptySide() }

	const add = (row: SampledLogRow, sideName: "before" | "after") => {
		const side = sides[sideName]
		side.read += 1
		const ts = rowText(row.timestamp)
		if (ts.length > 0) {
			if (side.from === undefined || ts < side.from) side.from = ts
			if (side.to === undefined || ts > side.to) side.to = ts
		}
		const body = rowText(row.body)
		if (body.length === 0) return
		side.sampled += 1
		const severity = rowText(row.severityText, "UNKNOWN")
		const level = isErrorSeverity(severity) ? "error" : "other"
		const mined = miners[level].addLogMessage(body)
		const key = `${level}:${mined.clusterId}`
		const cluster = clusters.get(key) ?? {
			template: mined.templateMined,
			sample: body,
			before: 0,
			after: 0,
			severityCounts: new Map<string, number>(),
			serviceCounts: new Map<string, number>(),
		}
		cluster.template = mined.templateMined
		cluster[sideName] += 1
		// The sample shows the side that defines the change: a new template's first log, not an old one.
		if (sideName === "after" && cluster.after === 1) cluster.sample = body
		incrementCount(cluster.severityCounts, severity)
		incrementCount(cluster.serviceCounts, rowText(row.serviceName, "unknown"))
		clusters.set(key, cluster)
	}
	for (const row of before.rows) add(row, "before")
	for (const row of after.rows) add(row, "after")

	const summary = {
		sampledBefore: sides.before.sampled,
		sampledAfter: sides.after.sampled,
		coverageBefore: coverage(sides.before),
		coverageAfter: coverage(sides.after),
	}
	if (sides.before.sampled === 0 || sides.after.sampled === 0) {
		return { ...summary, patterns: [], unchanged: clusters.size }
	}

	// The count query can trail the sample by a few late rows; never estimate below what was read.
	const estimate = (count: number, side: Side, total: number) =>
		Math.round((count / side.read) * Math.max(total, side.read))

	const changed = Arr.filterMap(Array.from(clusters.values()), (c) => {
		const verdict = classify(c, sides.before.sampled, sides.after.sampled)
		if (verdict === undefined) return Result.failVoid
		return Result.succeed({
			template: c.template,
			sample: c.sample,
			change: verdict.change,
			before: { sampled: c.before, estimated: estimate(c.before, sides.before, before.total) },
			after: { sampled: c.after, estimated: estimate(c.after, sides.after, after.total) },
			...(verdict.ratio === undefined ? undefined : { ratio: Math.round(verdict.ratio * 100) / 100 }),
			severityCounts: mapToObject(c.severityCounts),
			serviceCounts: mapToObject(c.serviceCounts),
			z: verdict.z,
		})
	})

	const patterns: LogPatternDiff[] = Arr.map(
		Arr.take(Arr.sort(changed, byRank), limit),
		({ z: _z, ...diff }) => diff,
	)
	return { ...summary, patterns, unchanged: clusters.size - changed.length }
}

/**
 * What changed in the logs between two windows, e.g. the hour before a deploy and the hour after.
 *
 * Reads a sample and the total count of each window (four queries, in parallel), then diffs
 * the templates in process. The samples are the logs nearest the boundary between the windows:
 * the before window's newest and the after window's oldest. Memory is O(2 × sampleSize).
 */
export const compareLogPatterns = Effect.fn("Observability.compareLogPatterns")(function* (
	input: CompareLogPatternsInput,
) {
	const executor = yield* WarehouseExecutor
	const sampleSize = input.sampleSize ?? DEFAULT_SAMPLE_SIZE
	// Both bounds are inclusive: end the before window a second early so no log counts twice.
	const before =
		input.before.endTime === input.after.startTime
			? {
					...input.before,
					endTime: formatWarehouseDateTime(parseWarehouseDateTime(input.before.endTime) - 1000),
				}
			: input.before
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
				{ ...window(before), limit: sampleSize },
				{ profile: "list" },
			),
			// Oldest first: with the before sample newest first, both sit against the boundary.
			executor.query<ListLogsOutput>(
				"list_logs",
				{ ...window(input.after), limit: sampleSize, order: "asc" },
				{ profile: "list" },
			),
			executor.query<{ readonly total: number | string }>("logs_count", window(before), {
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
		before: {
			timeRange: before,
			totalLogs: totals.before,
			sampled: diff.sampledBefore,
			...(diff.coverageBefore === undefined ? undefined : { sampleCoverage: diff.coverageBefore }),
		},
		after: {
			timeRange: input.after,
			totalLogs: totals.after,
			sampled: diff.sampledAfter,
			...(diff.coverageAfter === undefined ? undefined : { sampleCoverage: diff.coverageAfter }),
		},
		sampleSize,
		patterns: diff.patterns,
		unchanged: diff.unchanged,
	} satisfies CompareLogPatternsOutput
})
