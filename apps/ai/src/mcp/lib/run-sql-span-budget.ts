import { Effect, Option, Array as Arr, String as Str } from "effect"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { rawBreakdownSpanVerdict } from "@maple/query-engine/runtime"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { identifierText, referencedTableNames } from "./sql-identifiers"
import { withTenantExecutor } from "./query-warehouse"

/**
 * Spans a raw `traces` read of the attribute maps gets through in run_sql's 10-second limit
 * (max_threads=2): 3-7M spans/s measured on prod on 2026-11-07, so 30M leaves headroom.
 */
export const ATTRIBUTE_SCAN_SPAN_BUDGET = 30_000_000

/** At or under an hour the estimate costs more than the scans it would stop. */
const MIN_ESTIMATED_RANGE_MS = 60 * 60 * 1000

export interface AttributeScan {
	readonly startTime: string
	readonly endTime: string
	/** The services the query filters to; undefined means every service. */
	readonly services: ReadonlyArray<string> | undefined
	/** The window came from the SQL's own Timestamp bounds, not start_time/end_time. */
	readonly literalWindow: boolean
}

const toMs = parseWarehouseDateTime

const MAP_READ = /\b(?:SpanAttributes|ResourceAttributes)\b/
const TRACE_ID_FILTER = /\bTraceId\s*(?:=|\bIN\b)/i
const OWN_TIMESTAMP_BOUND = /\bTimestamp\s*(?:>=?|<=?|\bBETWEEN\b)/i
const DATE_TIME = String.raw`'(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)(?:\.\d+)?Z?'`
const LOWER_BOUND = new RegExp(String.raw`\bTimestamp\s*>=?\s*(?:toDateTime(?:64)?\(\s*)?${DATE_TIME}`, "gi")
const UPPER_BOUND = new RegExp(String.raw`\bTimestamp\s*<=?\s*(?:toDateTime(?:64)?\(\s*)?${DATE_TIME}`, "gi")

/** The window of the SQL's own `Timestamp >= '...'` / `<= '...'` bounds, when it has both. */
const literalWindow = (sql: string): { readonly startTime: string; readonly endTime: string } | undefined => {
	const lower = Arr.map(Arr.fromIterable(Str.matchAll(LOWER_BOUND)(sql)), (m) =>
		Str.replace("T", " ")(m[1] ?? ""),
	)
	const upper = Arr.map(Arr.fromIterable(Str.matchAll(UPPER_BOUND)(sql)), (m) =>
		Str.replace("T", " ")(m[1] ?? ""),
	)
	// More than one bound of a side means OR-ed windows or a subquery's own range: no guess.
	const [startTime, ...extraLower] = lower
	const [endTime, ...extraUpper] = upper
	if (startTime === undefined || endTime === undefined || extraLower.length > 0 || extraUpper.length > 0)
		return undefined
	return { startTime, endTime }
}

const quoted = (list: string) =>
	Arr.map(Arr.fromIterable(Str.matchAll(/'((?:[^'\\]|\\.)*)'/g)(list)), (m) => m[1] ?? "")

/**
 * The services a query keeps: one `ServiceName = 'x'` or `ServiceName IN ('a', 'b')`, or none
 * (every service). Any other use of `ServiceName` in a filter reads as unknown.
 */
const serviceFilter = (sql: string): Option.Option<ReadonlyArray<string> | undefined> => {
	const masked = identifierText(sql)
	const filters = Arr.fromIterable(
		Str.matchAll(/\bServiceName\s*(=|!=|<>|\bNOT\s+IN\b|\bIN\b|\bI?LIKE\b|\bNOT\s+I?LIKE\b)/gi)(masked),
	)
	if (filters.length === 0) return Option.some(undefined)
	const [only, ...others] = filters
	if (only === undefined || others.length > 0) return Option.none()
	const op = Str.toUpperCase(only[1] ?? "")
	const rest = Str.slice((only.index ?? 0) + only[0].length)(sql)
	if (op === "=") {
		const value = Str.match(/^\s*'((?:[^'\\]|\\.)*)'/)(rest)
		return Option.map(value, (m) => [m[1] ?? ""])
	}
	if (op === "IN") {
		if (/^\s*\(\s*(?:SELECT|WITH)\b/i.test(rest)) return Option.none()
		const list = Str.match(/^\s*\(([^)]*)\)/)(rest)
		return Option.flatMap(list, (m) => {
			const values = quoted(m[1] ?? "")
			return values.length === 0 ? Option.none() : Option.some(values)
		})
	}
	return Option.none()
}

/**
 * A raw `traces` read of the attribute maps over a window long enough to time out, with the
 * services it keeps. Undefined when the query is not one, or its shape is not one we can size.
 */
export const attributeScanOf = (
	sql: string,
	window: { readonly startTime: string; readonly endTime: string; readonly applied: boolean },
): AttributeScan | undefined => {
	const masked = identifierText(sql)
	if (!Arr.contains(referencedTableNames(sql), "traces") || !MAP_READ.test(masked)) return undefined
	if (TRACE_ID_FILTER.test(masked)) return undefined
	// A narrower bound of its own, or a LIMIT with no ORDER BY, can stop well short of the window.
	if (window.applied && OWN_TIMESTAMP_BOUND.test(Str.replace(/\$__timeFilter\([^)]*\)/g, "")(masked)))
		return undefined
	if (/\bLIMIT\b/i.test(masked) && !/\bORDER\s+BY\b/i.test(masked)) return undefined
	const own = window.applied ? undefined : literalWindow(sql)
	const range = window.applied ? window : own
	if (range === undefined) return undefined
	if (toMs(range.endTime) - toMs(range.startTime) <= MIN_ESTIMATED_RANGE_MS) return undefined
	const services = serviceFilter(sql)
	if (Option.isNone(services)) return undefined
	return {
		startTime: range.startTime,
		endTime: range.endTime,
		services: services.value,
		literalWindow: own !== undefined,
	}
}

const compact = (n: number): string =>
	n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : String(Math.round(n))

const describeHours = (hours: number) =>
	hours >= 48 && hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`

/** Why the scan would run out of time and the narrower window that would not, or undefined when it fits. */
export const spanBudgetMessage = (
	scan: AttributeScan,
	estimatedSpans: number,
	fittingRangeSeconds: number | undefined,
	budget = ATTRIBUTE_SCAN_SPAN_BUDGET,
): string => {
	const who =
		scan.services === undefined
			? "across every service"
			: `for ${Arr.join(
					Arr.map(scan.services, (s) => `\`${s}\``),
					", ",
				)}`
	const fittingHours =
		fittingRangeSeconds === undefined ? undefined : Math.floor(fittingRangeSeconds / 3600)
	const narrower =
		fittingHours === undefined || fittingHours < 1
			? "Narrow the window to under an hour"
			: scan.literalWindow
				? `Narrow the query's Timestamp bounds to ${describeHours(fittingHours)} or less`
				: `Narrow the window to ${describeHours(fittingHours)} or less (e.g. start_time='${formatWarehouseDateTime(toMs(scan.endTime) - fittingHours * 3600_000)}', end_time='${scan.endTime}')`
	return (
		`Not run: ${scan.startTime} to ${scan.endTime} holds about ${compact(estimatedSpans)} spans ${who}, and reading span attributes ` +
		`gets through about ${compact(budget)} before run_sql's 10-second limit. ${narrower}` +
		(scan.services === undefined ? ", or filter on `ServiceName = '...'`" : "") +
		". Rollups answer most counts without reading attributes: service_endpoint_details_hourly (per HTTP route and status), " +
		"service_operations_hourly (per span name), trace_list_mv (one root span per trace, with HttpRoute/HttpMethod/HttpStatusCode), " +
		"ai_trace_index (agent spans), attribute_values_hourly (which values a key takes)."
	)
}

export interface SpanBudgetCheck {
	readonly estimatedSpans: number
	/** Present when the scan is over budget: the message to fail with. */
	readonly refusal?: string
}

/** Sizes the scan from `service_usage`; fails open (undefined) when the estimate cannot be read. */
export const checkAttributeScanBudget = Effect.fn("McpRunSql.checkAttributeScanBudget")(function* (
	scan: AttributeScan,
) {
	const rows = yield* withTenantExecutor(
		Effect.gen(function* () {
			const executor = yield* WarehouseExecutor
			return yield* executor.compiledQuery(
				CH.compile(
					CH.traceSpanVolumeByServiceQuery(),
					{ orgId: executor.orgId, startTime: scan.startTime, endTime: scan.endTime },
					{ rowSchema: CH.traceSpanVolumeRowSchema },
				),
				{ profile: "list", context: "runSqlSpanEstimate" },
			)
		}),
	).pipe(
		Effect.catch((error) =>
			Effect.as(
				Effect.annotateCurrentSpan("maple.mcp.run_sql.span_estimate_error", error._tag),
				undefined,
			),
		),
	)
	if (rows === undefined) return undefined
	const verdict = rawBreakdownSpanVerdict(
		rows,
		scan.services === undefined ? {} : { serviceNames: scan.services },
		{ startMs: toMs(scan.startTime), endMs: toMs(scan.endTime) },
		ATTRIBUTE_SCAN_SPAN_BUDGET,
	)
	yield* Effect.annotateCurrentSpan({
		"maple.mcp.run_sql.estimated_spans": verdict.estimatedSpans,
		"maple.mcp.run_sql.span_budget_exceeded": verdict.exceeded !== undefined,
	})
	return {
		estimatedSpans: verdict.estimatedSpans,
		...(verdict.exceeded === undefined
			? undefined
			: {
					refusal: spanBudgetMessage(
						scan,
						verdict.estimatedSpans,
						verdict.exceeded.fittingRangeSeconds,
					),
				}),
	} satisfies SpanBudgetCheck
})
