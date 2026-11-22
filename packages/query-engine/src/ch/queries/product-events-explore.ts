// Product events as a query-builder source: the timeseries, breakdown, list and
// attribute-discovery shapes every dashboard panel, formula and alert rule can
// target. Funnels stay in `product-events.ts`; this module is the plain-count
// side of the same table, and it keeps the `/analytics` session filters by
// reusing `replaysWhere` so the two agree on what a filtered population is.

import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { param, from, inSubquery } from "@maple-dev/effect-orm/clickhouse"
import type { CHQuery, ColumnAccessor, ColumnDefs } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import {
	PRODUCT_EVENTS_NUMERIC_METRICS,
	PRODUCT_EVENTS_SESSION_GROUP_BY,
	type AttributeFilter,
	type ProductEventsGroupBy,
	type ProductEventsMetric,
	type ProductEventsNumericMetric,
	type ProductEventsSessionGroupBy,
} from "@maple/domain/query-engine"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "../tables"
import { buildAttrFilterCondition } from "../../traces-shared"
import { finalizeTimeseries } from "./series-cap"
import { soleValue, timeseriesBucket, wholeRangeEnd } from "./query-helpers"
import { replaysWhere, needsSessionSemiJoin, type WebAnalyticsFilters } from "./web-analytics"
import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"
import { Array as Arr, Record as Rec } from "effect"
import type { OpenJoinAccessor, OpenJoinQuery } from "./product-events"

type EventsColumns = typeof Datasources.productEvents.columns
type EventsAccessor = ColumnAccessor<EventsColumns>
/** The events with the session dimensions joined in as `sd` when a group-by reads one. */
type GroupedAccessor = OpenJoinAccessor<EventsColumns>

export type ProductEventsGroupByKey = ProductEventsGroupBy | "none"

/** The filter surface shared by every shape here — the `ProductEventsFilters` domain struct, flat. */
export interface ProductEventsQueryOpts {
	eventNames?: readonly string[]
	kinds?: readonly string[]
	sources?: readonly string[]
	hosts?: readonly string[]
	pagePaths?: readonly string[]
	serviceNames?: readonly string[]
	userIds?: readonly string[]
	groupIds?: readonly string[]
	excludedEventNames?: readonly string[]
	excludedKinds?: readonly string[]
	excludedSources?: readonly string[]
	excludedHosts?: readonly string[]
	excludedPagePaths?: readonly string[]
	excludedServiceNames?: readonly string[]
	attributeFilters?: readonly AttributeFilter[]
	groupByAttributeKey?: string
	valueAttributeKey?: string
	referrerHost?: string
	country?: string
	deviceType?: string
	browserName?: string
	osName?: string
	language?: string
	utmSource?: string
	utmMedium?: string
	utmCampaign?: string
	visitorType?: "new" | "returning"
}

export interface ProductEventsTimeseriesOpts extends ProductEventsQueryOpts {
	metric: ProductEventsMetric
	groupBy?: readonly ProductEventsGroupByKey[]
	bucketSeconds?: number
	seriesLimit?: number
	/** One bucket per group over the whole range; see `timeseriesBucket`. Alert evaluation sets it. */
	wholeRange?: boolean
}

export interface ProductEventsTimeseriesOutput {
	readonly bucket: DateTime.Utc
	readonly groupName: string
	readonly value: number
	/** Rows behind `value` — the alert sample count, which a `uniq` metric cannot stand in for. */
	readonly eventCount: number
}

export interface ProductEventsBreakdownOpts extends ProductEventsQueryOpts {
	metric: ProductEventsMetric
	groupBy: ProductEventsGroupBy
	limit?: number
}

export interface ProductEventsBreakdownOutput {
	readonly name: string
	readonly value: number
}

export interface ProductEventsListOpts extends ProductEventsQueryOpts {
	limit?: number
}

export interface ProductEventsListOutput {
	readonly timestamp: DateTime.Utc
	readonly eventName: string
	readonly kind: string
	readonly source: string
	readonly host: string
	readonly pagePath: string
	readonly url: string
	readonly serviceName: string
	readonly userId: string
	readonly groupId: string
	readonly visitorId: string
	readonly sessionId: string
	readonly traceId: string
	readonly spanId: string
	readonly attributes: Record<string, string>
	readonly seq: number
}

const inListOpt = (column: CH.Expr<string>, values: readonly string[] | undefined) =>
	values !== undefined && values.length > 0 ? CH.inList(column, values) : undefined

const notInListOpt = (column: CH.Expr<string>, values: readonly string[] | undefined) =>
	values !== undefined && values.length > 0 ? CH.notInList(column, values) : undefined

/** The session-side subset, in the shape `replaysWhere` reads. */
function sessionFilters(opts: ProductEventsQueryOpts): WebAnalyticsFilters {
	return {
		referrerHost: opts.referrerHost,
		country: opts.country,
		deviceType: opts.deviceType,
		browserName: opts.browserName,
		osName: opts.osName,
		language: opts.language,
		utmSource: opts.utmSource,
		utmMedium: opts.utmMedium,
		utmCampaign: opts.utmCampaign,
		visitorType: opts.visitorType,
		useProductEvents: true,
	}
}

function sessionSemiJoin($: EventsAccessor, opts: ProductEventsQueryOpts): CH.Condition | undefined {
	const filters = sessionFilters(opts)
	if (!needsSessionSemiJoin(filters)) return undefined
	return inSubquery(
		$.SessionId,
		from(Datasources.sessionReplays)
			.select(($s) => ({ sessionId: $s.SessionId }))
			.where(($s) => replaysWhere($s, filters))
			.groupBy("sessionId"),
	)
}

function eventConditions($: EventsAccessor, opts: ProductEventsQueryOpts): Array<CH.Condition | undefined> {
	return [
		$.OrgId.eq(orgIdParam),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		inListOpt($.EventName, opts.eventNames),
		inListOpt($.Kind, opts.kinds),
		inListOpt($.Source, opts.sources),
		inListOpt($.Host, opts.hosts),
		inListOpt($.PagePath, opts.pagePaths),
		inListOpt($.ServiceName, opts.serviceNames),
		inListOpt($.UserId, opts.userIds),
		inListOpt($.GroupId, opts.groupIds),
		notInListOpt($.EventName, opts.excludedEventNames),
		notInListOpt($.Kind, opts.excludedKinds),
		notInListOpt($.Source, opts.excludedSources),
		notInListOpt($.Host, opts.excludedHosts),
		notInListOpt($.PagePath, opts.excludedPagePaths),
		notInListOpt($.ServiceName, opts.excludedServiceNames),
		...Arr.map(opts.attributeFilters ?? [], (filter) => buildAttrFilterCondition(filter, "Attributes")),
		sessionSemiJoin($, opts),
	]
}

/** Row-local person key. No `identity_links` join: a count does not need the stitching a funnel does. */
const personKey = ($: EventsAccessor): CH.Expr<string> => CH.if_($.UserId.neq(""), $.UserId, $.VisitorId)

const isNumericMetric = (metric: ProductEventsMetric): metric is ProductEventsNumericMetric =>
	Arr.contains(PRODUCT_EVENTS_NUMERIC_METRICS, metric)

/**
 * `fn` over `Attributes[key]` read as a number. A prop that is missing, text, `NaN` or infinite is
 * no value, so one bad event cannot poison a bucket; a group with no values at all reads 0.
 */
function numericValue($: EventsAccessor, key: string): CH.Expr<number | null> {
	const parsed = CH.compileTypedFnCall(
		"toFloat64OrNull",
		T.nullable(T.float64).schema,
		$.Attributes.get(key),
	)
	return CH.compileTypedFnCall(
		"if",
		T.nullable(T.float64).schema,
		CH.compileFnCallCond("isFinite", parsed),
		parsed,
		CH.rawExpr("NULL", T.nullable(T.float64)),
	)
}

function numericExpr($: EventsAccessor, fn: ProductEventsNumericMetric, key: string): CH.Expr<number> {
	const value = numericValue($, key)
	const aggregate = (): CH.Expr<number | null> => {
		switch (fn) {
			case "sum":
				return CH.sum(value)
			case "avg":
				return CH.avg(value)
			case "min":
				return CH.min_(value)
			case "max":
				return CH.max_(value)
			case "p50":
				return CH.quantile(0.5)(value)
			case "p95":
				return CH.quantile(0.95)(value)
			case "p99":
				return CH.quantile(0.99)(value)
		}
	}
	return CH.ifNull(aggregate(), CH.lit(0))
}

function metricExpr(
	$: EventsAccessor,
	metric: ProductEventsMetric,
	valueAttributeKey: string | undefined,
): CH.Expr<number> {
	if (isNumericMetric(metric)) return numericExpr($, metric, valueAttributeKey ?? "")
	switch (metric) {
		case "count":
			return CH.count()
		case "sessions":
			return CH.uniqIf($.SessionId, $.SessionId.neq(""))
		case "persons":
			return CH.uniqIf(personKey($), $.UserId.neq("").or($.VisitorId.neq("")))
		case "users":
			return CH.uniqIf($.UserId, $.UserId.neq(""))
		case "visitors":
			return CH.uniqIf($.VisitorId, $.VisitorId.neq(""))
		case "groups":
			return CH.uniqIf($.GroupId, $.GroupId.neq(""))
	}
}

const SESSION_DIMENSION_COLUMN = {
	country: "Country",
	referrer_host: "ReferrerHost",
	utm_source: "UtmSource",
	utm_medium: "UtmMedium",
	utm_campaign: "UtmCampaign",
	device_type: "DeviceType",
	browser: "BrowserName",
	os: "OsName",
} as const satisfies Record<ProductEventsSessionGroupBy, keyof typeof Datasources.sessionReplays.columns>

const isSessionGroupBy = (key: string): key is ProductEventsSessionGroupBy =>
	Arr.contains(PRODUCT_EVENTS_SESSION_GROUP_BY, key)

const SESSION_ALIAS = "sd"

/** The browser SDK's session lifetime cap: no event is further than this from its session's start. */
const SESSION_MAX_LIFETIME_HOURS = 24

/**
 * One row per session with the dimensions asked for. `max()` so the row that carries a value
 * beats an un-merged earlier version's `''`.
 *
 * Sessions are read from a lifetime before the window on: an event early in the window belongs
 * to a session that started before it, and the timeseries cache re-runs a query on sub-ranges as
 * short as a minute, where nearly every event does. A session with no id is nobody's.
 */
function sessionDimensions(keys: ReadonlyArray<ProductEventsSessionGroupBy>) {
	const windowStart = CH.toDateTime(utcSecondsParam("startTime"))
	const sessionsFrom = CH.compileTypedFnCall(
		"subtractHours",
		CH.schemaOf<DateTime.Utc>(windowStart),
		windowStart,
		CH.lit(SESSION_MAX_LIFETIME_HOURS),
	)
	return from(Datasources.sessionReplays)
		.select(($) => ({
			SessionId: $.SessionId,
			...Rec.fromEntries(
				Arr.map(keys, (key) => [key, CH.max_($[SESSION_DIMENSION_COLUMN[key]])] as const),
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.StartTime.gte(sessionsFrom),
			$.StartTime.lte(param.dateTime("endTime")),
			$.SessionId.neq(""),
		])
		.groupBy("SessionId")
}

/** `product_events`, joined to its sessions' dimensions only when a group-by reads one. */
function eventsGroupedBy(groupBy: ReadonlyArray<ProductEventsGroupByKey>): OpenJoinQuery<EventsColumns> {
	const events: OpenJoinQuery<EventsColumns> = from(Datasources.productEvents)
	const keys = Arr.dedupe(Arr.filter(groupBy, isSessionGroupBy))
	return keys.length === 0
		? events
		: events.leftJoinQuery(sessionDimensions(keys), SESSION_ALIAS, (event, session) =>
				event.SessionId.eq(session.SessionId),
			)
}

function dimensionColumn(
	$: GroupedAccessor,
	key: ProductEventsGroupBy,
	attributeKey: string | undefined,
): CH.Expr<string> {
	if (isSessionGroupBy(key)) {
		// join_use_nulls=0 yields '' for an event with no session; coalesce covers a cluster that flips it.
		const dimension = $[SESSION_ALIAS]?.[key]
		return dimension === undefined ? CH.lit("") : CH.coalesce(dimension, CH.lit(""))
	}
	switch (key) {
		case "event_name":
			return $.EventName
		case "kind":
			return $.Kind
		case "source":
			return $.Source
		case "host":
			return $.Host
		case "page_path":
			return $.PagePath
		case "service":
			return $.ServiceName
		case "group":
			return $.GroupId
		case "attribute":
			return $.Attributes.get(attributeKey ?? "")
	}
}

// Every dimension keeps its position, an empty one shown as `(none)`, so
// `browser · (none)` and `(none) · browser` stay two groups.
function groupNameExpr($: GroupedAccessor, opts: ProductEventsTimeseriesOpts): CH.Expr<string> {
	const keys = Arr.filter(opts.groupBy ?? [], (key): key is ProductEventsGroupBy => key !== "none")
	if (keys.length === 0) return CH.lit("all")
	const parts = Arr.map(keys, (key) =>
		CH.coalesce(
			CH.nullIf(dimensionColumn($, key, opts.groupByAttributeKey), ""),
			CH.lit(WEB_ANALYTICS_UNSET),
		),
	)
	const onlyPart = soleValue(parts)
	if (onlyPart !== undefined) return onlyPart
	return CH.arrayStringConcat(CH.arrayOf(...parts), " · ")
}

const TS_COLUMNS: ColumnDefs = {
	bucket: T.dateTime64,
	groupName: T.string,
	value: T.float64,
	eventCount: T.float64,
}

export function productEventsTimeseriesQuery(
	opts: ProductEventsTimeseriesOpts,
): CHQuery<ColumnDefs, ProductEventsTimeseriesOutput> {
	const inner = eventsGroupedBy(opts.groupBy ?? [])
		.select(($) => ({
			bucket: timeseriesBucket($.Timestamp, opts.wholeRange),
			groupName: groupNameExpr($, opts),
			value: metricExpr($, opts.metric, opts.valueAttributeKey),
			// The sample count an alert reads: for a numeric metric, the events that carried a number,
			// so a window with events and no values is no data rather than a measured 0.
			eventCount: isNumericMetric(opts.metric)
				? CH.countIf(numericValue($, opts.valueAttributeKey ?? "").isNotNull())
				: CH.count(),
		}))
		.where(($) => [...eventConditions($, opts), wholeRangeEnd($.Timestamp, opts.wholeRange)])
		.groupBy("bucket", "groupName")
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
	return finalizeTimeseries(inner, TS_COLUMNS, "value", opts)
}

export function productEventsBreakdownQuery(
	opts: ProductEventsBreakdownOpts,
): CHQuery<ColumnDefs, ProductEventsBreakdownOutput> {
	return eventsGroupedBy([opts.groupBy])
		.select(($) => ({
			name: dimensionColumn($, opts.groupBy, opts.groupByAttributeKey),
			value: metricExpr($, opts.metric, opts.valueAttributeKey),
		}))
		.where(($) => eventConditions($, opts))
		.groupBy("name")
		.orderBy(["value", "desc"], ["name", "asc"])
		.limit(opts.limit ?? 10)
		.format("JSON")
}

export function productEventsListQuery(
	opts: ProductEventsListOpts,
): CHQuery<ColumnDefs, ProductEventsListOutput> {
	return from(Datasources.productEvents)
		.select(($) => ({
			timestamp: $.Timestamp,
			eventName: $.EventName,
			kind: $.Kind,
			source: $.Source,
			host: $.Host,
			pagePath: $.PagePath,
			url: $.Url,
			serviceName: $.ServiceName,
			userId: $.UserId,
			groupId: $.GroupId,
			visitorId: $.VisitorId,
			sessionId: $.SessionId,
			traceId: $.TraceId,
			spanId: $.SpanId,
			attributes: $.Attributes,
			seq: $.Seq,
		}))
		.where(($) => eventConditions($, opts))
		.orderBy(["timestamp", "desc"], ["seq", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export interface ProductEventAttributeKeysOpts extends ProductEventsQueryOpts {
	limit?: number
}

export interface ProductEventAttributeKeysOutput {
	readonly attributeKey: string
	readonly usageCount: number
}

/** The `track()` prop keys in use, most common first. No rollup exists; this scans the window. */
export function productEventAttributeKeysQuery(
	opts: ProductEventAttributeKeysOpts = {},
): CHQuery<ColumnDefs, ProductEventAttributeKeysOutput> {
	return from(Datasources.productEvents)
		.select(($) => ({
			attributeKey: CH.arrayJoin(CH.mapKeys($.Attributes)),
			usageCount: CH.count(),
		}))
		.where(($) => eventConditions($, opts))
		.groupBy("attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

export interface ProductEventAttributeValuesOpts extends ProductEventsQueryOpts {
	attributeKey: string
	limit?: number
}

export interface ProductEventAttributeValuesOutput {
	readonly attributeValue: string
	readonly usageCount: number
}

export function productEventAttributeValuesQuery(
	opts: ProductEventAttributeValuesOpts,
): CHQuery<ColumnDefs, ProductEventAttributeValuesOutput> {
	return from(Datasources.productEvents)
		.select(($) => ({
			attributeValue: $.Attributes.get(opts.attributeKey),
			usageCount: CH.count(),
		}))
		.where(($) => [
			...eventConditions($, opts),
			CH.has(CH.mapKeys($.Attributes), CH.lit(opts.attributeKey)),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}
