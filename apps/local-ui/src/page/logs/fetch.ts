import { compareSeverity } from "../../lib/log-shape"
import type { TimeBounds } from "../../lib/time"
import { CH } from "@maple/query-engine"
import type { LogsListOutput } from "@maple/query-engine/ch"
import { clusterLogPatterns } from "@maple/query-engine/observability"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { Effect } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import type { LogFilters } from "./filters"
import type { FacetOption, LocalLog, LogPatterns } from "./model"

// The Logs page's queries: the stream, its services and its patterns.

export const PAGE_SIZE = 50
/** Newest logs clustered per refresh. Smaller than the CLI's 10k: chDB serves one query at a time. */
export const PATTERN_SAMPLE_SIZE = 5_000
const PATTERN_LIMIT = 100

export type LogCursor = NonNullable<CH.LogsListOpts["cursorIdentity"]>

/** `normalizeLog`: attribute maps parsed once, the exact timestamp kept as the cursor field. */
const normalizeLog = (row: LogsListOutput): LocalLog => ({
	timestamp: row.exactTimestamp,
	severityText: row.severityText,
	severityNumber: row.severityNumber,
	serviceName: row.serviceName,
	body: row.body,
	traceId: row.traceId,
	spanId: row.spanId,
	recordIdentity: row.recordIdentity,
	logAttributes: parseAttributes(row.logAttributes),
	resourceAttributes: parseAttributes(row.resourceAttributes),
})

/** One page, newest first, keyset-paged on the full row identity. */
export const fetchLogsPage = (filters: LogFilters, bounds: TimeBounds, cursor: LogCursor | undefined, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.logsListQuery({
					limit: PAGE_SIZE,
					cursorIdentity: cursor,
					serviceName: filters.service,
					severity: filters.severity,
					search: filters.search,
				}),
				localParams(bounds),
			),
			apiBase,
		),
		(rows) => rows.map(normalizeLog),
	)

const toOptions = (rows: ReadonlyArray<{ readonly name: string; readonly count: number }>): Array<FacetOption> =>
	rows.filter((row) => row.name).map((row) => ({ name: row.name, count: row.count }))

/** Severity facet: every filter except severity itself, ordered by level, not count. */
export const fetchSeverities = (filters: LogFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.logsBreakdownQuery({ groupBy: "severity", limit: 20, serviceName: filters.service, search: filters.search }),
				localParams(bounds),
			),
			apiBase,
		),
		(rows) => toOptions(rows).sort((a, b) => compareSeverity(a.name, b.name)),
	)

/** Services that logged in the window, under every log filter except the service itself. */
export const fetchServices = (filters: LogFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.logsBreakdownQuery({
					groupBy: "service",
					limit: null,
					source: "raw",
					severity: filters.severity,
					search: filters.search,
				}),
				localParams({ startTime: bounds.startTime, endTime: bounds.endTime }),
			),
			apiBase,
		),
		toOptions,
	)

/** Drain templates over the newest logs matching the list's filters, clustered in the browser. */
export const fetchPatterns = (filters: LogFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.logsListQuery({
					limit: PATTERN_SAMPLE_SIZE,
					serviceName: filters.service,
					severity: filters.severity,
					search: filters.search,
				}),
				localParams(bounds),
			),
			apiBase,
		),
		(rows): LogPatterns => ({
			patterns: clusterLogPatterns(rows, PATTERN_LIMIT).patterns,
			// clusterLogPatterns skips empty bodies, so they stay out of the share denominator.
			totalSampled: rows.filter((row) => String(row.body ?? "") !== "").length,
			isTruncated: rows.length >= PATTERN_SAMPLE_SIZE,
		}),
	)

/** `getNextPageParam`: only a full page asks for another. */
export const nextCursor = (page: ReadonlyArray<LocalLog>): LogCursor | undefined => {
	const last = page.length === PAGE_SIZE ? page[page.length - 1] : undefined
	return last
		? {
				timestamp: last.timestamp,
				serviceName: last.serviceName,
				traceId: last.traceId,
				spanId: last.spanId,
				recordIdentity: last.recordIdentity,
			}
		: undefined
}
