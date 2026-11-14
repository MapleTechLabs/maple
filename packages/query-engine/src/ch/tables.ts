// Maple Table Definitions
//
// The query tables ARE the warehouse datasources in
// packages/domain/src/tinybird/datasources.ts; read them as `Datasources.*`. A
// column declared with `utcDateTime()`/`utcDateTime64()` decodes as a
// `DateTime.Utc`; the rest still decode as the strings ClickHouse sends.

import { DateTime, Option, Schema, SchemaGetter, String as Str } from "effect"
import * as T from "@maple-dev/effect-orm/clickhouse"
import * as CH from "@maple-dev/effect-orm/expr"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { parseUtc } from "../datetime"

/**
 * The type every attribute column in the warehouse has.
 *
 * Named so helpers that work across tables — anything taking "a table with a
 * `SpanAttributes` column" — can say so structurally without falling back to
 * `ColumnRef<"SpanAttributes", any>`. An `any` there erases the map's value
 * type, and `$.SpanAttributes.get(k)` then decodes as `unknown`, which costs
 * the query its derived row schema.
 */
export type StringMap = T.CHMap<T.CHString, T.CHString>

/**
 * Every datasource brands `OrgId` (and the error tables `TraceId`/`SpanId`), so
 * a query that SELECTs one derives the brand without a declared `rowSchema`.
 * Comparisons take the brand too: compare `OrgId` with `orgIdParam`.
 */
export const orgId = Datasources.traces.columns.OrgId

/** The tenant param every warehouse query filters `OrgId` on. */
export const orgIdParam = T.param.of(orgId, "orgId")

/**
 * A string bound written as a `DateTime` literal: floored to whole seconds, as
 * `param.dateTimeSeconds` does, since the column rejects a fractional literal.
 */
const FlooredSecondsString = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.passthrough(),
		encode: SchemaGetter.transform((value: string) =>
			Option.match(parseUtc(value), {
				onNone: () => value,
				onSome: (utc) => Str.replace("T", " ")(Str.slice(0, 19)(DateTime.formatIso(utc))),
			}),
		),
	}),
)

const utcSeconds = T.custom(
	"DateTime",
	T.dateTime.schema,
	Schema.Union([T.dateTime.schema, FlooredSecondsString]),
)

/**
 * A `DateTime.Utc` bound for a second-precision `DateTime` column, floored to
 * whole seconds (a string bound too). It may share a name with a
 * `param.dateTime` bound on a `DateTime64` column. Use it instead of
 * `param.dateTimeSeconds`, which in effect-orm 0.3.0 only accepts strings at
 * runtime despite its type.
 */
export const utcSecondsParam = <const N extends string>(name: N) => T.param.of(utcSeconds, name)

const WIRE_DATETIME64 = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})?$/

/**
 * A `DateTime64(9)` bound from a `toString(Timestamp)` literal, which keeps the
 * nanoseconds a `DateTime.Utc` drops: a millisecond keyset cursor would skip
 * rows sharing the boundary millisecond. Any other string fails `compile` on
 * the column's codec, as a typed `QueryBuilderError`.
 */
export const exactDateTime64 = (value: string): CH.Expr<DateTime.Utc> | string =>
	WIRE_DATETIME64.test(value) ? CH.makeExpr(CH.toFragment(CH.lit(value)), T.dateTime64.schema) : value

/** The `traces.Timestamp` range a reader scans, bounding its `trace_index` lookup to the same days. */
export interface TraceWindow {
	readonly start: CH.Expr<DateTime.Utc>
	readonly end: CH.Expr<DateTime.Utc>
}

// A bound may compile to a string with nanoseconds, which neither `toDateTime`
// nor a `DateTime` comparison parses; `toDateTime64(x, 9)` takes every shape.
export const asDateTime64 = (value: CH.Expr<DateTime.Utc>) =>
	CH.compileTypedFnCall("toDateTime64", T.dateTime64.schema, value, CH.lit(9))

/** A {@link TraceWindow} from the query's `DateTime64` bound params. */
export const paramTraceWindow = (start = "startTime", end = "endTime"): TraceWindow => ({
	start: T.param.dateTime(start),
	end: T.param.dateTime(end),
})

/** A {@link TraceWindow} from two known instants, such as a session's own span. */
export const utcTraceWindow = (start: DateTime.Utc, end: DateTime.Utc): TraceWindow => ({
	start: utcDateTime64Literal(start),
	end: utcDateTime64Literal(end),
})

const utcDateTime64Literal = (value: DateTime.Utc): CH.Expr<DateTime.Utc> =>
	CH.makeExpr(
		CH.toFragment(CH.lit(Str.replace("Z", "")(Str.replace("T", " ")(DateTime.formatIso(value))))),
		T.dateTime64.schema,
	)

/** The `trace_index.Bucket` a span starting at `value` lands in. */
export const traceBucketOf = (value: CH.Expr<DateTime.Utc>) =>
	CH.compileTypedFnCall(Datasources.TRACE_BUCKET_FN, T.dateTime.schema, asDateTime64(value))

// A span's bucket floors its start, so the lower bound floors too.
const traceIndexBucketBounds = (bucket: CH.Expr<DateTime.Utc>, window: TraceWindow | undefined) => [
	window && bucket.gte(traceBucketOf(window.start)),
	window && bucket.lte(asDateTime64(window.end)),
]

/**
 * Selects the spans of the traces `match` picks from `trace_index`, for a query
 * reading `traces`. The index names every `(ServiceName, bucket, TraceId)` sort-key
 * prefix those traces occupy, so the read seeks their granules instead of scanning.
 *
 * `window` is required so every caller decides: an unbounded lookup by a subquery
 * set probes every retained partition and timed out the trace list (2026-10-19).
 * Pass `undefined` only for a literal trace id with no known time.
 */
export const inTraces = <Q>(
	match: (traceId: T.ColumnRef<"TraceId", T.CHString>) => CH.Condition<Q>,
	window: TraceWindow | undefined,
) =>
	T.subqueryCond(
		T.from(Datasources.traceIndex)
			.select(($) => ({ ServiceName: $.ServiceName, Bucket: $.Bucket, TraceId: $.TraceId }))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				match($.TraceId),
				...traceIndexBucketBounds($.Bucket, window),
			]),
		(sql) =>
			`(traces.ServiceName, ${Datasources.TRACE_BUCKET_FN}(traces.Timestamp), traces.TraceId) IN (${sql})`,
	)

/**
 * {@link inTraces} for `service_map_spans`, sorted `(OrgId, <trace bucket>, TraceId, SpanId)`:
 * the index's `(bucket, TraceId)` pairs seek the matched traces' granules.
 */
export const inServiceMapSpans = <Q>(
	match: (traceId: T.ColumnRef<"TraceId", T.CHString>) => CH.Condition<Q>,
	window: TraceWindow,
) =>
	T.subqueryCond(
		T.from(Datasources.traceIndex)
			.select(($) => ({ Bucket: $.Bucket, TraceId: $.TraceId }))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				match($.TraceId),
				...traceIndexBucketBounds($.Bucket, window),
			]),
		(sql) =>
			`(${Datasources.TRACE_BUCKET_FN}(service_map_spans.Timestamp), service_map_spans.TraceId) IN (${sql})`,
	)
