// Warehouse reads behind the setup audit (`GET /v2/instrumentation/audit`).
//
// Two rules hold throughout this file:
//
//  1. **Rates are computed app-side.** Every query returns raw counts — a numerator and its
//     denominator — never a division. The builder's arithmetic follows SQL precedence rather than
//     call order, and mixing Float64 quotients into otherwise-integer result sets is how UNION type
//     unification breaks; returning counts sidesteps both, and `nan`/`ifNotFinite` handling with it.
//  2. **Pre-aggregated MVs over raw scans.** Only `auditLogCorrelationQuery`,
//     `auditRootlessTracesSQL`, `auditServiceResourceKeysQuery` and the follow-ups (key attribution,
//     per-metric labels, inbound routes, uncorrelated log messages) touch a raw table, each reading a
//     few narrow columns over a hard-clamped window; only the message follow-up reads a log `Body`. Attribute *values* are never scanned org-wide: a `Map` re-read at that
//     scale is what previously exhausted query memory.
//
// Every builder filters `OrgId` (enforced at execution) and every count/sum/uniq column needs
// `CHNumber` in the caller's `rowSchema` — ClickHouse serializes 64-bit integers as JSON strings, so
// a BYO-ClickHouse org otherwise fails to decode.

import * as CH from "@maple-dev/effect-orm/clickhouse"
import { compile, from, fromQuery, param, type CompiledQuery } from "@maple-dev/effect-orm/clickhouse"
import { Schema, Effect, Array as Arr } from "effect"
import {
	AttributeKeysHourly,
	AttributeValuesHourly,
	Logs,
	LogsAggregatesHourly,
	MetricsSum,
	ServiceMapChildren,
	ServiceMapDbEdgesHourly,
	ServiceMapSpans,
	ServiceOverviewHourly,
	ServiceRuntimesHourly,
	TraceListMv,
	Traces,
	TracesAggregatesHourly,
	orgIdParam,
	utcSecondsParam,
} from "@maple/query-engine/ch/tables"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { utcHourFloor } from "@maple/query-engine/ch/query-helpers"
import * as T from "@maple-dev/effect-orm/clickhouse"
import type { QueryBuilderError } from "@maple-dev/effect-orm/clickhouse"
import type { OrgId } from "@maple/domain"

/** Snaps a window bound to its hour floor so any overlapping hour of an hourly MV contributes. */

/** Span kinds and status codes Maple stores; anything else is an SDK emitting the wrong casing. */
const VALID_SPAN_KINDS = ["Server", "Client", "Producer", "Consumer", "Internal", ""]
const VALID_STATUS_CODES = ["Ok", "Error", "Unset", ""]

const quoteList = (values: ReadonlyArray<string>) =>
	Arr.join(
		Arr.map(values, (value) => `'${value}'`),
		", ",
	)

// A2 — attribute key inventory (all scopes, one scan)

export interface AuditAttributeKeyRow {
	readonly scope: string
	readonly attributeKey: string
	readonly usageCount: number
}

export const auditAttributeKeyInventoryRowSchema = Schema.Struct({
	scope: Schema.String,
	attributeKey: Schema.String,
	usageCount: CHNumber,
})

/**
 * Every attribute key the org emitted, across all four scopes, in one read. `attribute_keys_hourly`
 * is sorted `(OrgId, AttributeScope, Hour, AttributeKey)`, so restricting the scope set is a prefix
 * read rather than a scan — this replaces what would otherwise be four separate queries.
 *
 * Powers the semconv-rename, naming, reserved-namespace, PII-key-name and resource-coverage checks,
 * all of which are pure functions over this one result.
 */
export function auditAttributeKeyInventoryQuery(opts: { limit?: number } = {}) {
	return from(AttributeKeysHourly)
		.select(($) => ({
			scope: $.AttributeScope,
			attributeKey: $.AttributeKey,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			CH.inList($.AttributeScope, ["span", "resource", "log", "metric"]),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("scope", "attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 2000)
		.format("JSON")
}

// A3 — per-service span shape

export interface AuditSpanProfileRow {
	readonly serviceName: string
	readonly weightedSpanCount: number
	readonly weightedErrorCount: number
	readonly serverCount: number
	readonly consumerCount: number
	readonly clientCount: number
	readonly producerCount: number
	readonly noEnvCount: number
	readonly spanNameCount: number
	readonly badStatusCodes: ReadonlyArray<string>
	readonly badSpanKinds: ReadonlyArray<string>
	/** The busiest root span that is not Server/Consumer, at most one; with its kind. */
	readonly rootSpanNames: ReadonlyArray<string>
	readonly rootSpanKinds: ReadonlyArray<string>
}

export const auditSpanProfileRowSchema = Schema.Struct({
	serviceName: Schema.String,
	weightedSpanCount: CHNumber,
	weightedErrorCount: CHNumber,
	serverCount: CHNumber,
	consumerCount: CHNumber,
	clientCount: CHNumber,
	producerCount: CHNumber,
	noEnvCount: CHNumber,
	spanNameCount: CHNumber,
	badStatusCodes: Schema.Array(Schema.String),
	badSpanKinds: Schema.Array(Schema.String),
	rootSpanNames: Schema.Array(Schema.String),
	rootSpanKinds: Schema.Array(Schema.String),
})

/** An entry-point row that is not Server/Consumer is a root span (`IsEntryPoint` covers both). */
const NON_ENTRY_ROOT = "IsEntryPoint = 1 AND SpanKind NOT IN ('Server', 'Consumer')"
const TOP_ROOT_SPAN = `topKWeightedIf(1)((SpanName, SpanKind), toUInt64(WeightedCount), ${NON_ENTRY_ROOT})`

/**
 * Per-service span shape from `traces_aggregates_hourly`, which already carries every dimension the
 * audit needs — kind, status, environment and span name — so no raw span read is required.
 *
 * Run this under the `list` profile, not `discovery`: an org whose span names carry IDs (exactly what
 * the span-name cardinality check detects) inflates this MV enough to exceed a 5s budget.
 */
export function auditSpanProfileByServiceQuery(opts: { limit?: number } = {}) {
	return from(TracesAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			weightedSpanCount: CH.sum($.WeightedCount),
			weightedErrorCount: CH.sum($.WeightedErrorCount),
			serverCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Server")),
			consumerCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Consumer")),
			clientCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Client")),
			producerCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Producer")),
			noEnvCount: CH.sumIf($.WeightedCount, $.DeploymentEnv.eq("")),
			spanNameCount: CH.uniq($.SpanName),
			// Bounded samples of the offending literals so the finding can name them.
			badStatusCodes: CH.rawExpr(
				`groupUniqArrayIf(5)(StatusCode, StatusCode NOT IN (${quoteList(VALID_STATUS_CODES)}))`,
				T.array(T.string),
			),
			badSpanKinds: CH.rawExpr(
				`groupUniqArrayIf(5)(SpanKind, SpanKind NOT IN (${quoteList(VALID_SPAN_KINDS)}))`,
				T.array(T.string),
			),
			// What a service without Server/Consumer spans starts its traces with, so STAT-04 can name it.
			// Both read one aggregate over the (name, kind) pair, so the kind belongs to that span.
			rootSpanNames: CH.rawExpr(`arrayMap(p -> p.1, ${TOP_ROOT_SPAN})`, T.array(T.string)),
			rootSpanKinds: CH.rawExpr(`arrayMap(p -> p.2, ${TOP_ROOT_SPAN})`, T.array(T.string)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["weightedSpanCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// A3b — span-name templates

export interface AuditSpanNameTemplateRow {
	readonly serviceName: string
	readonly rawNameCount: number
	readonly templateCount: number
	/** Raw names behind the busiest template, and up to three of them. */
	readonly topTemplateNameCount: number
	readonly exampleNames: ReadonlyArray<string>
}

export const auditSpanNameTemplateRowSchema = Schema.Struct({
	serviceName: Schema.String,
	rawNameCount: CHNumber,
	templateCount: CHNumber,
	topTemplateNameCount: CHNumber,
	exampleNames: Schema.Array(Schema.String),
})

/** Below this many distinct names a service is never reported, so the template pass skips it. */
export const AUDIT_SPAN_NAME_MIN_RAW = 100

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

/**
 * A string expression with its IDs replaced: UUIDs, `prefix_<base62 12+>` ids and hex runs of 8+ (each
 * holding a digit, so `request_processing` and `decadefaced` survive), then every digit run.
 * Tokenizing with `extractAll` keeps the separators, so only ids change.
 */
const templateIdsSql = (expr: string) =>
	`replaceRegexpAll(arrayStringConcat(arrayMap(tok -> multiIf(match(tok, '^[A-Za-z]+_[A-Za-z0-9]{12,}$') AND match(tok, '[0-9]'), '{id}', match(tok, '^[0-9a-fA-F]{8,}$') AND match(tok, '[0-9]'), '{hex}', tok), extractAll(replaceRegexpAll(${expr}, '${UUID_PATTERN}', '{uuid}'), '[A-Za-z0-9_]+|[^A-Za-z0-9_]+'))), '[0-9]+', '{n}')`

const SPAN_NAME_TEMPLATE_SQL = templateIdsSql("spanName")

/** `http.route`, else the raw path with its query string and fragment cut and its IDs templated. */
const INBOUND_ROUTE_SQL = `if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], ${templateIdsSql(
	"replaceRegexpOne(if(SpanAttributes['url.path'] != '', SpanAttributes['url.path'], SpanAttributes['http.target']), '[?#].*$', '')",
)})`

/**
 * Distinct span names per service against distinct names once IDs are templated out: many raw names
 * per template is an ID in the name, many templates is a genuinely large operation set. Reads the
 * service's distinct names from `traces_aggregates_hourly`, then templates only those.
 */
export function auditSpanNameTemplatesQuery() {
	const names = from(TracesAggregatesHourly)
		.select(($) => ({ serviceName: $.ServiceName, spanName: $.SpanName }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
		])
		.groupBy("serviceName", "spanName")

	const templates = fromQuery(names, "n")
		.select(($) => ({
			serviceName: $.serviceName,
			template: CH.rawExpr(SPAN_NAME_TEMPLATE_SQL, T.string),
			names: CH.count(),
			examples: CH.rawExpr("groupArray(3)(spanName)", T.array(T.string)),
		}))
		.groupBy("serviceName", "template")

	return fromQuery(templates, "t")
		.select(($) => ({
			serviceName: $.serviceName,
			rawNameCount: CH.sum($.names),
			templateCount: CH.count(),
			topTemplateNameCount: CH.max($.names),
			exampleNames: CH.argMax($.examples, $.names),
		}))
		.groupBy("serviceName")
		.having(($) => [CH.sum($.names).gt(AUDIT_SPAN_NAME_MIN_RAW)])
		.orderBy(["rawNameCount", "desc"])
		.limit(200)
		.format("JSON")
}

// A4 — per-service sampling weight and commit tagging

export interface AuditSamplingRow {
	readonly serviceName: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly commitTaggedSpanCount: number
}

export const auditSamplingRowSchema = Schema.Struct({
	serviceName: Schema.String,
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
	commitTaggedSpanCount: CHNumber,
})

/**
 * `service_overview_hourly` is the only rollup carrying both the raw `SpanCount` and the
 * sampling-extrapolated `EstimatedSpanCount`, so it is the only cheap source for a service's
 * effective sample weight — the input to "these services disagree about how much they sample".
 *
 * `CommitSha` is pre-extracted from `vcs.ref.head.revision`. It is a per-service proxy for release
 * tagging; the authoritative resource-key coverage comes from A2.
 */
export function auditSamplingByServiceQuery(opts: { limit?: number } = {}) {
	return from(ServiceOverviewHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			spanCount: CH.sum($.SpanCount),
			estimatedSpanCount: CH.sum($.EstimatedSpanCount),
			commitTaggedSpanCount: CH.sumIf($.SpanCount, $.CommitSha.neq("")),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["spanCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// A5 — per-service log severity distribution

export interface AuditLogSeverityRow {
	readonly serviceName: string
	readonly severityText: string
	readonly logCount: number
}

export const auditLogSeverityRowSchema = Schema.Struct({
	serviceName: Schema.String,
	severityText: Schema.String,
	logCount: CHNumber,
})

/**
 * Severity literals per service. Feeds the non-standard-severity check directly, and supplies the
 * "this service logs errors" half of the heuristic that catches exceptions swallowed as `Unset`.
 */
export function auditLogSeverityByServiceQuery(opts: { limit?: number } = {}) {
	return from(LogsAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			severityText: $.SeverityText,
			logCount: CH.sum($.Count),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
		])
		.groupBy("serviceName", "severityText")
		.orderBy(["logCount", "desc"])
		.limit(opts.limit ?? 2000)
		.format("JSON")
}

// A6 — metric label cardinality

export interface AuditMetricLabelRow {
	readonly attributeKey: string
	readonly valueCardinality: number
	readonly usageCount: number
}

export const auditMetricLabelRowSchema = Schema.Struct({
	attributeKey: Schema.String,
	valueCardinality: CHNumber,
	usageCount: CHNumber,
})

/**
 * Distinct value counts per metric label. `uniq` (HyperLogLog) rather than `uniqExact` — the check
 * only cares whether cardinality is in the thousands, and an approximate count is bounded-memory by
 * construction, which matters precisely on the exploded-label orgs this detects.
 *
 * Caveat the check text must carry: the metric attribute rollups materialize from `metrics_sum`
 * only, so this covers counters, not gauges or histograms.
 */
export function auditMetricLabelCardinalityQuery(opts: { limit?: number } = {}) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			valueCardinality: CH.uniq($.AttributeValue),
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.AttributeScope.eq("metric"),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("attributeKey")
		.orderBy(["valueCardinality", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

// A7 — peer / dependency identifier values

/** Keys whose *values* name a dependency, where inconsistent spelling fragments a service-map node. */
export const AUDIT_PEER_KEYS = [
	"service.peer.name",
	"peer.service",
	"db.system",
	"db.system.name",
	"messaging.system",
	"rpc.system.name",
	"rpc.system",
] as const

export interface AuditPeerValueRow {
	readonly attributeKey: string
	readonly attributeValue: string
	readonly usageCount: number
}

export const auditPeerValueRowSchema = Schema.Struct({
	attributeKey: Schema.String,
	attributeValue: Schema.String,
	usageCount: CHNumber,
})

/**
 * The distinct values behind each dependency-naming key. Case-collision detection (`tinybird` vs
 * `Tinybird`) happens app-side; the query just enumerates. Restricted to seven keys, so this is a
 * bounded read of `attribute_values_hourly` rather than an attribute-value scan.
 */
export function auditPeerValueInventoryQuery(opts: { limit?: number } = {}) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.AttributeScope.eq("span"),
			CH.inList($.AttributeKey, [...AUDIT_PEER_KEYS]),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.AttributeValue.neq(""),
		])
		.groupBy("attributeKey", "attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// A8 — database edge identity

export interface AuditDbEdgeRow {
	readonly serviceName: string
	readonly dbSystem: string
	/** As the service map keys the node: empty, the `hyperdrive` sentinel, or a host fallback included. */
	readonly dbNamespace: string
	readonly callCount: number
}

export const auditDbEdgeRowSchema = Schema.Struct({
	serviceName: Schema.String,
	dbSystem: Schema.String,
	dbNamespace: Schema.String,
	callCount: CHNumber,
})

/**
 * Database map edges per namespace, exactly as the service map keys its database nodes. The caller
 * judges which namespaces carry no identity (empty, `hyperdrive`, a bare host) and whether one
 * database is split across a named and an unnamed node.
 */
export function auditDbEdgeIdentityQuery(opts: { limit?: number } = {}) {
	return from(ServiceMapDbEdgesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			dbSystem: $.DbSystem,
			dbNamespace: $.DbNamespace,
			callCount: CH.sum($.CallCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
			$.DbSystem.neq(""),
		])
		.groupBy("serviceName", "dbSystem", "dbNamespace")
		.orderBy(["callCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// A9 — service identity, for telling Maple-written and client services apart

export interface AuditServiceIdentityRow {
	readonly serviceName: string
	readonly namespaces: ReadonlyArray<string>
	readonly environments: ReadonlyArray<string>
}

export const auditServiceIdentityRowSchema = Schema.Struct({
	serviceName: Schema.String,
	namespaces: Schema.Array(Schema.String),
	environments: Schema.Array(Schema.String),
})

/** Non-empty `service.namespace`s and environments per traced service, from the overview rollup. */
export function auditServiceIdentityQuery(opts: { limit?: number } = {}) {
	return from(ServiceOverviewHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			namespaces: CH.groupUniqArrayIf(5)($.ServiceNamespace, $.ServiceNamespace.neq("")),
			environments: CH.groupUniqArrayIf(10)($.DeploymentEnv, $.DeploymentEnv.neq("")),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
		])
		.groupBy("serviceName")
		.limit(opts.limit ?? 500)
		.format("JSON")
}

export interface AuditServiceSdkRow {
	readonly serviceName: string
	readonly sdkLanguages: ReadonlyArray<string>
}

export const auditServiceSdkRowSchema = Schema.Struct({
	serviceName: Schema.String,
	sdkLanguages: Schema.Array(Schema.String),
})

/** `telemetry.sdk.language` per traced service (`webjs`, `swift`, ...), from the runtimes rollup. */
export function auditServiceSdkQuery(opts: { limit?: number } = {}) {
	return from(ServiceRuntimesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			sdkLanguages: CH.groupUniqArrayIf(5)($.SdkLanguage, $.SdkLanguage.neq("")),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcHourFloor("endTime")),
		])
		.groupBy("serviceName")
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// A10 — resource values behind suspect keys

export interface AuditResourceValueRow {
	readonly attributeKey: string
	readonly attributeValue: string
	readonly usageCount: number
}

export const auditResourceValueRowSchema = Schema.Struct({
	attributeKey: Schema.String,
	attributeValue: Schema.String,
	usageCount: CHNumber,
})

/** Sample values of a few resource keys, so a finding can judge what the key actually holds. */
export function auditResourceValueSamplesQuery(keys: ReadonlyArray<string>, opts: { limit?: number } = {}) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.AttributeScope.eq("resource"),
			CH.inList($.AttributeKey, keys),
			$.Hour.gte(utcSecondsParam("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("attributeKey", "attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

// A11 — which services emit a given key (bounded raw follow-ups)
//
// The key rollups carry no service, so naming the emitter takes a raw read. Both run only for the
// handful of keys a check already flagged, read one map's keys and nothing else, and cap their rows.

/** Upper bound on the raw `traces` window for resource-key attribution. */
export const AUDIT_RESOURCE_KEY_SERVICE_MAX_HOURS = 1

export interface AuditKeyServiceRow {
	readonly serviceName: string
	/** Rows carrying each requested key, aligned with the `keys` argument. */
	readonly keyCounts: ReadonlyArray<number>
}

export const auditKeyServiceRowSchema = Schema.Struct({
	serviceName: Schema.String,
	keyCounts: Schema.Array(CHNumber),
})

const keyPresence = (map: CH.Expr<Record<string, string>>, keys: Arr.NonEmptyReadonlyArray<string>) => {
	const has = Arr.map(keys, (key) => CH.mapContains(map, key))
	return {
		any: Arr.reduce(Arr.tailNonEmpty(has), Arr.headNonEmpty(has), (a, b) => a.or(b)),
		counts: CH.arrayOf(...Arr.map(has, (condition) => CH.countIf(condition))),
	}
}

export interface AuditResourceKeyServiceRow extends AuditKeyServiceRow {
	/** Rows where a pair's key and its semconv twin hold the same (or prefix-equal) value, aligned with `duplicatePairs`. */
	readonly duplicateCounts: ReadonlyArray<number>
}

export const auditResourceKeyServiceRowSchema = Schema.Struct({
	serviceName: Schema.String,
	keyCounts: Schema.Array(CHNumber),
	duplicateCounts: Schema.Array(CHNumber),
})

/**
 * Services whose span resources carry any of `keys`, over a short raw `traces` window. Each
 * `[key, target]` in `duplicatePairs` counts rows where both hold the same value, compared in place.
 */
const COMMIT_SHA_PATTERN = "^[0-9a-fA-F]{7,40}$"

export function auditResourceKeyServicesQuery(
	keys: Arr.NonEmptyReadonlyArray<string>,
	opts: { readonly duplicatePairs?: ReadonlyArray<readonly [string, string]> } = {},
) {
	const pairs = opts.duplicatePairs ?? []
	return (
		from(Traces)
			.select(($) => ({
				serviceName: $.ServiceName,
				keyCounts: keyPresence($.ResourceAttributes, keys).counts,
				duplicateCounts: CH.arrayOf(
					...Arr.map(pairs, ([key, target]) => {
						const value = $.ResourceAttributes.get(key)
						const twin = $.ResourceAttributes.get(target)
						// A prefix match needs 7+ chars on the shorter side, so `1` never matches `1f3a…`.
						const prefix = twin
							.startsWith(value)
							.and(CH.matchCond(value, "^.{7,}"))
							.or(value.startsWith(twin).and(CH.matchCond(twin, "^.{7,}")))
						const same = value.neq("").and(twin.neq("")).and(value.eq(twin).or(prefix))
						// A SHA kept in service.version is still the only revision: removing its twin loses it.
						return CH.countIf(
							target === "service.version"
								? same.and(CH.not(CH.matchCond(value, COMMIT_SHA_PATTERN)))
								: same,
						)
					}),
				),
			}))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				$.Timestamp.gte(param.dateTime("startTime")),
				$.Timestamp.lte(param.dateTime("endTime")),
				keyPresence($.ResourceAttributes, keys).any,
			])
			.groupBy("serviceName")
			// The busiest emitters first, ties by name, so the capped list is stable between runs.
			.orderBy((_columns) => [
				[CH.rawExpr("arraySum(keyCounts)", T.uint64), "desc"],
				[CH.rawExpr("serviceName", T.string), "asc"],
			])
			.limit(20)
			.format("JSON")
	)
}

/** Upper bound on the raw `traces` window for naming who emits a sensitive-looking span key. */
export const AUDIT_SENSITIVE_KEY_MAX_HOURS = 1

export interface AuditSensitiveKeyEmitterRow {
	readonly serviceName: string
	readonly spanName: string
	/** Spans carrying each requested key, aligned with the `keys` argument. */
	readonly keyCounts: ReadonlyArray<number>
}

export const auditSensitiveKeyEmitterRowSchema = Schema.Struct({
	serviceName: Schema.String,
	spanName: Schema.String,
	keyCounts: Schema.Array(CHNumber),
})

/**
 * Service and span name behind span keys PII-01 flagged. Presence only: the attribute value is
 * never selected, since it is the suspected secret.
 */
export function auditSensitiveKeyEmittersQuery(keys: Arr.NonEmptyReadonlyArray<string>) {
	return from(Traces)
		.select(($) => ({
			serviceName: $.ServiceName,
			spanName: $.SpanName,
			keyCounts: keyPresence($.SpanAttributes, keys).counts,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			keyPresence($.SpanAttributes, keys).any,
		])
		.groupBy("serviceName", "spanName")
		.orderBy((_columns) => [
			[CH.rawExpr("arraySum(keyCounts)", T.uint64), "desc"],
			[CH.rawExpr("serviceName", T.string), "asc"],
			[CH.rawExpr("spanName", T.string), "asc"],
		])
		.limit(20)
		.format("JSON")
}

/**
 * The raw `metrics_sum` window for per-metric label cardinality: the rollup's 24h, so both count
 * against one threshold over the same span (measured ~0.5s median on prod at 2.3M rows a day).
 */
export const AUDIT_METRIC_LABEL_MAX_HOURS = 24

export interface AuditMetricLabelByMetricRow {
	readonly serviceName: string
	readonly metricName: string
	/** Distinct values of each requested label on this metric, aligned with the `keys` argument. */
	readonly valueCardinalities: ReadonlyArray<number>
}

export const auditMetricLabelByMetricRowSchema = Schema.Struct({
	serviceName: Schema.String,
	metricName: Schema.String,
	valueCardinalities: Schema.Array(CHNumber),
})

/**
 * Per-metric cardinality of labels the org-wide rollup flagged. `attribute_values_hourly` carries no
 * service or metric, so its count is the union over every metric; this confirms it per series family.
 * `collapseServicePrefixes` folds the services Maple writes itself into one row per prefix and metric,
 * so they cannot fill the row cap yet still show the label was seen (and is Maple's, not the user's).
 */
export function auditMetricLabelByMetricQuery(
	keys: Arr.NonEmptyReadonlyArray<string>,
	opts: { readonly collapseServicePrefixes?: ReadonlyArray<string> } = {},
) {
	const prefixes = opts.collapseServicePrefixes ?? []
	return from(MetricsSum)
		.select(($) => ({
			serviceName: Arr.isReadonlyArrayNonEmpty(prefixes)
				? CH.multiIf(
						Arr.map(
							prefixes,
							(prefix) => [$.ServiceName.startsWith(prefix), CH.lit(prefix)] as const,
						),
						$.ServiceName,
					)
				: $.ServiceName,
			metricName: $.MetricName,
			valueCardinalities: CH.arrayOf(
				...Arr.map(keys, (key) =>
					CH.uniqIf($.Attributes.get(key), CH.mapContains($.Attributes, key)),
				),
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			keyPresence($.Attributes, keys).any,
		])
		.groupBy("serviceName", "metricName")
		.orderBy((_columns) => [[CH.rawExpr("arrayMax(valueCardinalities)", T.uint64), "desc"]])
		.limit(200)
		.format("JSON")
}

// A12 — release keys per service (bounded raw read)

/** Upper bound on the raw `traces` window for per-service resource keys. */
export const AUDIT_SERVICE_RESOURCE_MAX_HOURS = 6

export interface AuditServiceResourceKeyRow {
	readonly serviceName: string
	readonly spanCount: number
	/** Entry spans carrying each requested key, aligned with the `keys` argument. */
	readonly keyCounts: ReadonlyArray<number>
}

export const auditServiceResourceKeyRowSchema = Schema.Struct({
	serviceName: Schema.String,
	spanCount: CHNumber,
	keyCounts: Schema.Array(CHNumber),
})

/**
 * Trace-sampling divisor for {@link auditServiceResourceKeysQuery}: the completeness joins' modulus
 * (sized for one hour) scaled to this read's six, so large orgs scan the same volume. Small orgs stay unsampled.
 */
export function auditServiceResourceSampleModulus(spanCountOverLookback: number): number {
	const modulus = auditTraceSampleModulus(spanCountOverLookback)
	return modulus > 1 ? modulus * AUDIT_SERVICE_RESOURCE_MAX_HOURS : 1
}

/**
 * Which services set each resource key. No rollup keeps resource keys per service, so this reads
 * entry spans only (`IsEntryPoint`, which still covers every client's roots), trace-sampled on large
 * orgs; a key is per-resource, so any kept span answers for its service. No key predicate: a service
 * setting none of the keys is exactly the row the checks need.
 */
export function auditServiceResourceKeysQuery(
	keys: Arr.NonEmptyReadonlyArray<string>,
	opts: { readonly traceSampleModulus?: number } = {},
) {
	const modulus = normalizeModulus(opts.traceSampleModulus)
	return from(Traces)
		.select(($) => ({
			serviceName: $.ServiceName,
			spanCount: CH.count(),
			keyCounts: keyPresence($.ResourceAttributes, keys).counts,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.IsEntryPoint.eq(1),
			modulusFilter($.TraceId, modulus),
		])
		.groupBy("serviceName")
		.orderBy(["spanCount", "desc"])
		.limit(500)
		.format("JSON")
}

// B1 — log ↔ trace correlation (bounded raw read)

/** Upper bound on the raw `logs` window, applied in the builder — callers cannot widen it. */
export const AUDIT_LOG_CORRELATION_MAX_HOURS = 6

export interface AuditLogCorrelationRow {
	readonly serviceName: string
	readonly logCount: number
	readonly uncorrelatedCount: number
	readonly errorLogCount: number
	readonly uncorrelatedErrorCount: number
	/** Non-standard severity texts seen with a valid `SeverityNumber` (1-24), and without one. */
	readonly numberedOddSeverities: ReadonlyArray<string>
	readonly unnumberedOddSeverities: ReadonlyArray<string>
}

export const auditLogCorrelationRowSchema = Schema.Struct({
	serviceName: Schema.String,
	logCount: CHNumber,
	uncorrelatedCount: CHNumber,
	errorLogCount: CHNumber,
	uncorrelatedErrorCount: CHNumber,
	numberedOddSeverities: Schema.Array(Schema.String),
	unnumberedOddSeverities: Schema.Array(Schema.String),
})

/** Characters of a log body kept for the top-message sample; the caller trims further. */
const LOG_MESSAGE_PREFIX_CHARS = 120

/** Severity text outside OTel's levels, ignoring case and a numeric suffix (`DEBUG3`). */
const ODD_SEVERITY = `SeverityText != '' AND replaceRegexpOne(upper(trim(SeverityText)), '[0-9]+$', '') NOT IN ('TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERROR', 'FATAL')`
const VALID_SEVERITY_NUMBER = "SeverityNumber BETWEEN 1 AND 24"

/**
 * How many of each service's logs carry no `TraceId` — the signal for a log bridge that sits off the
 * path the application actually logs through, which silently costs every trace↔log jump.
 *
 * A raw read, kept narrow: no attribute `Map` and no `Body` (the message sample is a follow-up over
 * the flagged services only). Filtered on both `TimestampTime` (day-partition pruning) and `Timestamp`.
 * Error-level logs are counted separately: uncorrelated startup and cron logs are normal, an
 * uncorrelated error log is a debugging dead end.
 *
 * `excludeServiceNames` drops services Maple writes itself (CI logs dwarf everything else).
 */
export function auditLogCorrelationQuery(opts: { excludeServiceNames?: ReadonlyArray<string> } = {}) {
	const isErrorSeverity = CH.rawCond("upper(SeverityText) IN ('ERROR', 'FATAL')")
	const excluded = opts.excludeServiceNames ?? []
	return from(Logs)
		.select(($) => ({
			serviceName: $.ServiceName,
			logCount: CH.count(),
			uncorrelatedCount: CH.countIf($.TraceId.eq("")),
			errorLogCount: CH.countIf(isErrorSeverity),
			uncorrelatedErrorCount: CH.countIf($.TraceId.eq("").and(isErrorSeverity)),
			numberedOddSeverities: CH.rawExpr(
				`groupUniqArrayIf(10)(SeverityText, ${ODD_SEVERITY} AND ${VALID_SEVERITY_NUMBER})`,
				T.array(T.string),
			),
			unnumberedOddSeverities: CH.rawExpr(
				`groupUniqArrayIf(10)(SeverityText, ${ODD_SEVERITY} AND NOT (${VALID_SEVERITY_NUMBER}))`,
				T.array(T.string),
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimestampTime.gte(utcSecondsParam("startTime")),
			$.TimestampTime.lte(utcSecondsParam("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			excluded.length > 0 ? CH.notInList($.ServiceName, excluded) : undefined,
		])
		.groupBy("serviceName")
		.orderBy(["logCount", "desc"])
		.limit(500)
		.format("JSON")
}

/** Window of the uncorrelated-message follow-up; the counts above keep their own six hours. */
export const AUDIT_LOG_MESSAGE_MAX_HOURS = 1

export interface AuditUncorrelatedLogMessageRow {
	readonly serviceName: string
	/** The commonest uncorrelated message, as a prefix; at most one. */
	readonly topMessages: ReadonlyArray<string>
}

export const auditUncorrelatedLogMessageRowSchema = Schema.Struct({
	serviceName: Schema.String,
	topMessages: Schema.Array(Schema.String),
})

/**
 * The commonest log line without a `TraceId`, for the few services LOG-02 already flagged. The only
 * read of `Body`: seeks by service (the sort-key prefix) over a short window, uncorrelated lines only.
 */
export function auditUncorrelatedLogMessagesQuery(serviceNames: Arr.NonEmptyReadonlyArray<string>) {
	return from(Logs)
		.select(($) => ({
			serviceName: $.ServiceName,
			topMessages: CH.rawExpr(
				`topK(1)(leftUTF8(Body, ${LOG_MESSAGE_PREFIX_CHARS}))`,
				T.array(T.string),
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			CH.inList($.ServiceName, serviceNames),
			$.TimestampTime.gte(utcSecondsParam("startTime")),
			$.TimestampTime.lte(utcSecondsParam("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.TraceId.eq(""),
		])
		.groupBy("serviceName")
		.limit(50)
		.format("JSON")
}

// B2 / B3 — trace completeness
//
// The orphan join mirrors the service-map edge join, which is the same join over the same two tables
// and the same window size that `ServiceMapRollupService` already runs once per org per hour in
// production. The rootless join reads raw `traces` over the same two hours, narrow columns only, so
// trace sampling bounds its hash side but not its scan. Do not widen either window, and never put
// them on a dashboard-polled path.
//
// What they can and cannot say: the warehouse only ever sees what arrived, so neither query can
// detect ingest loss. They are *internal consistency* checks — spans that reference a parent nobody
// sent, and traces observed with no root. Word every finding that way.

/**
 * Deterministic 1-in-N trace sampling, applied to **both** sides of a join so every span of a kept
 * trace survives on both — per-trace join correctness is exact, only the rate's variance widens.
 *
 * Without it a high-volume org builds a multi-gigabyte hash table on the parent side. Pick N from the
 * org's own span volume rather than a fixed value: {@link auditTraceSampleModulus}.
 *
 * Returns `undefined` at modulus 1 so `where()` drops the predicate entirely rather than emitting a
 * tautology.
 */
const modulusFilter = (traceId: CH.Expr<string>, modulus: number) =>
	modulus > 1 ? CH.cityHash64(traceId).mod(modulus).eq(0) : undefined

/** Clamps a caller-supplied modulus into a sane power-of-two-ish range. */
const normalizeModulus = (modulus: number | undefined) =>
	Math.max(1, Math.min(1024, Math.round(modulus ?? 1)))

/**
 * Trace-sampling divisor for the completeness joins, chosen from the org's observed span volume over
 * the audit's lookback window. Keeps the join's hash side in the low hundreds of megabytes at any
 * scale; small orgs pay nothing.
 */
export function auditTraceSampleModulus(spanCountOverLookback: number): number {
	if (spanCountOverLookback < 1_000_000) return 1
	if (spanCountOverLookback < 20_000_000) return 4
	return 16
}

/** `th:<hex>` in the W3C TraceState marks a consistent-probability sampling decision. */
const SAMPLED_TRACE_STATE_PATTERN = "th:[0-9a-f]+"

export interface AuditOrphanSpanRow {
	readonly serviceName: string
	readonly childCount: number
	readonly orphanCount: number
	readonly sampledOrphanCount: number
	/** Unsampled orphans in traces with no root in the org: the caller is outside it. */
	readonly externalParentCount: number
	/** Orphans inside traces that did start in the org, the ones worth inspecting. */
	readonly sampleTraceIds: ReadonlyArray<string>
}

export interface AuditTraceWindowParams {
	readonly orgId: OrgId
	/** Children considered, half-open: `[childStart, childEnd)`. */
	readonly childStart: string
	readonly childEnd: string
	/** Parents scanned from here — earlier than `childStart`, to cover long-running parents. */
	readonly parentStart: string
	readonly traceSampleModulus?: number
}

/** Trace ids with a root span in the window: `trace_list_mv` holds exactly the `ParentSpanId = ''` spans. */
const rootIndex = (modulus: number) =>
	from(TraceListMv)
		.select(($) => ({ TraceId: $.TraceId }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("parentStart")),
			$.Timestamp.lt(utcSecondsParam("childEnd")),
			modulusFilter($.TraceId, modulus),
		])
		.groupBy("TraceId")

/**
 * Entry-point spans (Server/Consumer) whose parent span never arrived.
 *
 * `service_map_children` holds Server/Consumer spans that declare a parent; `service_map_spans` holds
 * Client/Producer/Server/Consumer spans. A LEFT JOIN — not ANTI — so one pass yields both the
 * denominator and the numerator; with `join_use_nulls = 0` a miss surfaces as an empty `p.SpanId`.
 *
 * Two causes produce an orphan, and both are worth fixing: the caller's span genuinely never arrived
 * (dropped export or broken context propagation), or the caller modeled its outbound call as an
 * `Internal` span, which `service_map_spans` excludes — and which is separately why that call draws
 * no edge on the service map.
 *
 * `sampledOrphanCount` splits out orphans inside sampling-marked traces, where a dropped parent is
 * expected rather than a defect; the caller reports those as a sampling observation instead.
 *
 * `externalParentCount` splits out orphans whose trace has no root anywhere in the org (a lookup in
 * `trace_list_mv`, the root-span index): the request arrived carrying a caller's `traceparent` from
 * outside, such as a public API or MCP client. Nothing of the org's is missing there.
 */
export function auditOrphanSpansSQL(
	params: AuditTraceWindowParams,
): Effect.Effect<CompiledQuery<AuditOrphanSpanRow>, QueryBuilderError> {
	const modulus = normalizeModulus(params.traceSampleModulus)

	const children = from(ServiceMapChildren)
		.select(($) => ({
			TraceId: $.TraceId,
			ParentSpanId: $.ParentSpanId,
			ServiceName: $.ServiceName,
			TraceState: $.TraceState,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("childStart")),
			$.Timestamp.lt(utcSecondsParam("childEnd")),
			$.ParentSpanId.neq(""),
			modulusFilter($.TraceId, modulus),
		])

	const parents = from(ServiceMapSpans)
		.select(($) => ({ TraceId: $.TraceId, SpanId: $.SpanId }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("parentStart")),
			$.Timestamp.lt(utcSecondsParam("childEnd")),
			modulusFilter($.TraceId, modulus),
		])

	const query = fromQuery(children, "c")
		.leftJoinQuery(parents, "p", (c, p) => c.TraceId.eq(p.TraceId).and(c.ParentSpanId.eq(p.SpanId)))
		.leftJoinQuery(rootIndex(modulus), "r", (c, r) => c.TraceId.eq(r.TraceId))
		.select(($) => {
			// With ClickHouse's default `join_use_nulls = 0`, an unmatched LEFT JOIN
			// row yields '' rather than NULL — which is what makes this the orphan
			// test. `leftJoinQuery` types the joined side as nullable, so compare
			// through a non-null assertion-free coalesce.
			const missedParent = $.p.SpanId.eq("")
			const sampled = CH.matchCond($.TraceState, SAMPLED_TRACE_STATE_PATTERN)
			return {
				serviceName: $.ServiceName,
				childCount: CH.count(),
				orphanCount: CH.countIf(missedParent),
				sampledOrphanCount: CH.countIf(missedParent.and(sampled)),
				externalParentCount: CH.countIf(missedParent.and(CH.not(sampled)).and($.r.TraceId.eq(""))),
				sampleTraceIds: CH.groupUniqArrayIf(3)($.TraceId, missedParent.and($.r.TraceId.neq(""))),
			}
		})
		.groupBy("serviceName")
		.orderBy(["orphanCount", "desc"])
		.limit(200)
		.format("JSON")

	return compile(query, {
		orgId: params.orgId,
		childStart: params.childStart,
		childEnd: params.childEnd,
		parentStart: params.parentStart,
	})
}

/**
 * Spans the org's ingest sampler keeps even from traces it drops (`org_ingest_sampling_policies`).
 * A rootless trace made only of such spans is the sampler's doing, not a lost root.
 */
export interface AuditSamplingOverrides {
	readonly keepErrorSpans: boolean
	readonly slowSpanNs: number | null
}

/** Trace ids kept per service from external-parent traces; the route follow-up reads these. */
export const AUDIT_EXTERNAL_TRACE_SAMPLE = 10

export interface AuditRootlessTraceRow {
	readonly entryService: string
	readonly traceCount: number
	readonly rootlessCount: number
	readonly sampledRootlessCount: number
	/** Unsampled rootless traces that start at a Server/Consumer span with a parent: an outside caller. */
	readonly externalParentCount: number
	readonly externalTraceIds: ReadonlyArray<string>
	/** Org-wide totals over every service, including those past the row cap. */
	readonly orgTraceCount: number
	readonly orgRootlessCount: number
	readonly orgSampledRootlessCount: number
	readonly orgExternalParentCount: number
}

/**
 * Every trace that starts in the window, and whether its root span ever arrived. `trace_list_mv` is
 * populated strictly from `ParentSpanId = ''` spans of every kind, so it *is* the root-span index —
 * the join is a lookup, not a scan.
 *
 * The trace side reads every span from `traces`, not just entry spans: the commonest gap is a root
 * that was never exported (a serverless runtime frozen before the root span ended and flushed), and
 * those traces may hold no other Server/Consumer span at all. It reads from `parentStart` and keeps
 * only traces whose first span is inside the window, so a long-running trace that began earlier is
 * not mistaken for one whose root went missing. The `org*` columns are window totals over every
 * service, so the org-wide rate holds even past the row cap.
 *
 * `sampledRootlessCount` covers both ways a sampler explains a missing root: a `th:` TraceState, and
 * a trace made only of spans the ingest sampler keeps from dropped traces (`overrides`).
 *
 * Attribution uses `argMin(ServiceName, Timestamp)`: the earliest service Maple actually observed.
 * When the true root belongs to an uninstrumented upstream, that names the first instrumented hop,
 * which is exactly where the fix goes.
 *
 * `externalParentCount` counts rootless traces whose first span is a Server/Consumer span that
 * declares a parent: the caller's context came from outside the org. A Server span wins a timestamp
 * tie, since runtimes with frozen clocks start a handler and its first outbound call together.
 */
export function auditRootlessTracesSQL(
	params: AuditTraceWindowParams,
	overrides: AuditSamplingOverrides | null,
): Effect.Effect<CompiledQuery<AuditRootlessTraceRow>, QueryBuilderError> {
	const modulus = normalizeModulus(params.traceSampleModulus)

	const traces = from(Traces)
		.select(($) => {
			const kept = Arr.filter(
				[
					overrides?.keepErrorSpans === true ? $.StatusCode.eq("Error") : undefined,
					overrides?.slowSpanNs != null ? $.Duration.gte(overrides.slowSpanNs) : undefined,
				],
				(condition) => condition !== undefined,
			)
			const keptBySampler = Arr.isReadonlyArrayNonEmpty(kept)
				? Arr.reduce(Arr.tailNonEmpty(kept), Arr.headNonEmpty(kept), (a, b) => a.or(b))
				: undefined
			return {
				TraceId: $.TraceId,
				entryService: CH.argMin($.ServiceName, $.Timestamp),
				// `match` returns UInt8, so max() over the trace's spans is "any span
				// carried a sampling threshold".
				thresholdSampled: CH.max(CH.match($.TraceState, SAMPLED_TRACE_STATE_PATTERN)),
				// Zero when every span is one the ingest sampler keeps from dropped traces.
				unkeptSpans: keptBySampler === undefined ? CH.count() : CH.countIf(CH.not(keptBySampler)),
				externalParent: CH.rawExpr(
					`argMin(toUInt8(SpanKind IN ('Server', 'Consumer') AND ParentSpanId != ''), (Timestamp, SpanKind NOT IN ('Server', 'Consumer')))`,
					T.uint8,
				),
			}
		})
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("parentStart")),
			$.Timestamp.lt(utcSecondsParam("childEnd")),
			modulusFilter($.TraceId, modulus),
		])
		.groupBy("TraceId")
		.having(($) => [CH.min($.Timestamp).gte(utcSecondsParam("childStart"))])

	const query = fromQuery(traces, "t")
		.leftJoinQuery(rootIndex(modulus), "r", (t, r) => t.TraceId.eq(r.TraceId))
		.select(($) => {
			// `join_use_nulls = 0` turns a miss into '' — see auditOrphanSpansSQL.
			const noRoot = $.r.TraceId.eq("")
			const sampled = $.thresholdSampled.eq(1).or($.unkeptSpans.eq(0))
			const external = noRoot.and(CH.not(sampled)).and($.externalParent.eq(1))
			const traceCount = CH.count()
			const rootlessCount = CH.countIf(noRoot)
			const sampledRootlessCount = CH.countIf(noRoot.and(sampled))
			const externalParentCount = CH.countIf(external)
			const allServices = CH.windowSpec({
				frame: CH.rowsBetween(CH.unboundedPreceding, CH.unboundedFollowing),
			})
			return {
				entryService: $.entryService,
				traceCount,
				rootlessCount,
				sampledRootlessCount,
				externalParentCount,
				externalTraceIds: CH.groupUniqArrayIf(AUDIT_EXTERNAL_TRACE_SAMPLE)($.TraceId, external),
				orgTraceCount: CH.over(CH.sum(traceCount), allServices),
				orgRootlessCount: CH.over(CH.sum(rootlessCount), allServices),
				orgSampledRootlessCount: CH.over(CH.sum(sampledRootlessCount), allServices),
				orgExternalParentCount: CH.over(CH.sum(externalParentCount), allServices),
			}
		})
		.groupBy("entryService")
		// Past the cap, keep the services with the most traces; the rate comes from the org* totals.
		.orderBy(["traceCount", "desc"])
		.limit(1000)
		.format("JSON")

	return compile(query, {
		orgId: params.orgId,
		childStart: params.childStart,
		childEnd: params.childEnd,
		parentStart: params.parentStart,
	})
}

export interface AuditInboundRouteRow {
	readonly serviceName: string
	readonly route: string
	readonly traceCount: number
}

export const auditInboundRouteRowSchema = Schema.Struct({
	serviceName: Schema.String,
	route: Schema.String,
	traceCount: CHNumber,
})

/**
 * The route each sampled external-parent trace entered by, for the rootless rows that reported one.
 * A raw read, but seeks by service (the sort-key prefix) and a short trace-id list, inbound spans only.
 */
export function auditInboundRoutesQuery(
	serviceNames: Arr.NonEmptyReadonlyArray<string>,
	traceIds: Arr.NonEmptyReadonlyArray<string>,
) {
	const firstInbound = from(Traces)
		.select(($) => ({
			TraceId: $.TraceId,
			serviceName: CH.argMin($.ServiceName, $.Timestamp),
			route: CH.argMin(CH.rawExpr(INBOUND_ROUTE_SQL, T.string), $.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			CH.inList($.ServiceName, serviceNames),
			$.Timestamp.gte(utcSecondsParam("parentStart")),
			$.Timestamp.lt(utcSecondsParam("childEnd")),
			CH.inList($.SpanKind, ["Server", "Consumer"]),
			$.ParentSpanId.neq(""),
			CH.inList($.TraceId, traceIds),
		])
		.groupBy("TraceId")

	return fromQuery(firstInbound, "f")
		.select(($) => ({
			serviceName: $.serviceName,
			route: $.route,
			traceCount: CH.count(),
		}))
		.groupBy("serviceName", "route")
		.orderBy(["traceCount", "desc"])
		.limit(50)
		.format("JSON")
}
