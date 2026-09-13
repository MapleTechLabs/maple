// Product events as a query-builder source: the timeseries, breakdown, list and
// attribute-discovery shapes every dashboard panel, formula and alert rule can
// target. Funnels stay in `product-events.ts`; this module is the plain-count
// side of the same table, and it keeps the `/analytics` session filters by
// reusing `replaysWhere` so the two agree on what a filtered population is.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import { param, from, inSubquery } from "@maple-dev/effect-clickhouse"
import type { CHQuery, ColumnAccessor, ColumnDefs } from "@maple-dev/effect-clickhouse"
import * as T from "@maple-dev/effect-clickhouse/types"
import type { AttributeFilter, ProductEventsGroupBy, ProductEventsMetric } from "@maple/domain/query-engine"
import { ProductEvents, SessionReplays } from "../tables"
import { buildAttrFilterCondition } from "../../traces-shared"
import { finalizeTimeseries } from "./series-cap"
import { soleValue } from "./query-helpers"
import { replaysWhere, needsSessionSemiJoin, type WebAnalyticsFilters } from "./web-analytics"
import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"

type EventsAccessor = ColumnAccessor<typeof ProductEvents.columns>

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
}

export interface ProductEventsTimeseriesOutput {
	readonly bucket: string
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
	readonly timestamp: string
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
		from(SessionReplays)
			.select(($s) => ({ sessionId: $s.SessionId }))
			.where(($s) => replaysWhere($s, filters))
			.groupBy("sessionId"),
	)
}

function eventConditions($: EventsAccessor, opts: ProductEventsQueryOpts): Array<CH.Condition | undefined> {
	return [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTimeString("startTime")),
		$.Timestamp.lte(param.dateTimeString("endTime")),
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
		...(opts.attributeFilters ?? []).map((filter) => buildAttrFilterCondition(filter, "Attributes")),
		sessionSemiJoin($, opts),
	]
}

/** Row-local person key. No `identity_links` join: a count does not need the stitching a funnel does. */
const personKey = ($: EventsAccessor): CH.Expr<string> => CH.if_($.UserId.neq(""), $.UserId, $.VisitorId)

function metricExpr($: EventsAccessor, metric: ProductEventsMetric): CH.Expr<number> {
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
	}
}

function dimensionColumn(
	$: EventsAccessor,
	key: ProductEventsGroupBy,
	attributeKey: string | undefined,
): CH.Expr<string> {
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
function groupNameExpr($: EventsAccessor, opts: ProductEventsTimeseriesOpts): CH.Expr<string> {
	const keys = (opts.groupBy ?? []).filter((key): key is ProductEventsGroupBy => key !== "none")
	if (keys.length === 0) return CH.lit("all")
	const parts = keys.map((key) =>
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
	bucket: T.string,
	groupName: T.string,
	value: T.float64,
	eventCount: T.float64,
}

export function productEventsTimeseriesQuery(
	opts: ProductEventsTimeseriesOpts,
): CHQuery<ColumnDefs, ProductEventsTimeseriesOutput, {}> {
	const inner = from(ProductEvents)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			groupName: groupNameExpr($, opts),
			value: metricExpr($, opts.metric),
			eventCount: CH.count(),
		}))
		.where(($) => eventConditions($, opts))
		.groupBy("bucket", "groupName")
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
	return finalizeTimeseries(inner, TS_COLUMNS, "value", opts) as CHQuery<
		ColumnDefs,
		ProductEventsTimeseriesOutput,
		{}
	>
}

export function productEventsBreakdownQuery(
	opts: ProductEventsBreakdownOpts,
): CHQuery<any, ProductEventsBreakdownOutput, any> {
	return from(ProductEvents)
		.select(($) => ({
			name: dimensionColumn($, opts.groupBy, opts.groupByAttributeKey),
			value: metricExpr($, opts.metric),
		}))
		.where(($) => eventConditions($, opts))
		.groupBy("name")
		.orderBy(["value", "desc"], ["name", "asc"])
		.limit(opts.limit ?? 10)
		.format("JSON")
}

export function productEventsListQuery(
	opts: ProductEventsListOpts,
): CHQuery<any, ProductEventsListOutput, any> {
	return from(ProductEvents)
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
): CHQuery<any, ProductEventAttributeKeysOutput, any> {
	return from(ProductEvents)
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
): CHQuery<any, ProductEventAttributeValuesOutput, any> {
	return from(ProductEvents)
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
