import { Effect, Predicate } from "effect"
import { encodePublicId, PublicIdPrefixes, type PublicIdPrefix } from "@maple/domain/http/v2"
import {
	runSetupAudit,
	type AuditAffectedEntity,
	type ConfigAuditInputs,
	type SetupAuditReport,
	type TraceCompletenessInputs,
	type WarehouseAuditInputs,
} from "@maple/domain/setup-audit"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { parityOrgId, type FixtureWarehouse } from "../../backend/warehouse.ts"
import type { EndpointHandler, EndpointRequest, SyncedRow } from "../dataset.ts"
import { DAY } from "../identity.ts"

/**
 * `instrumentationAudit.retrieve`: `SetupAuditService.run` (packages/backend) and the v2 mapping
 * of `setup-audit.http.ts`. The warehouse half runs the same queries on the fixture warehouse;
 * the Postgres half reads the dataset's synced alerting rows, everything else is unconfigured.
 */

const LOOKBACK_HOURS = 24
const TRACE_WINDOW_MINUTES = 60
const TRACE_WINDOW_LAG_MINUTES = 15
const TRACE_PARENT_LOOKBACK_MINUTES = 60

const text = (row: SyncedRow, key: string): string => {
	const value = row[key]
	return typeof value === "string" ? value : ""
}
const nullableText = (row: SyncedRow, key: string): string | null => {
	const value = row[key]
	return typeof value === "string" ? value : null
}
const epochMs = (row: SyncedRow, key: string): number | null => {
	const value = row[key]
	return typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : null
}
const stringList = (row: SyncedRow, key: string): ReadonlyArray<string> => {
	const value = row[key]
	return Array.isArray(value) ? value.filter(Predicate.isString) : []
}

const configInputs = (request: EndpointRequest, firstDataReceivedAt: number | null): ConfigAuditInputs => {
	const synced = request.dataset.synced
	return {
		firstDataReceivedAt,
		alertRules: (synced.alert_rules ?? []).map((row) => ({
			id: text(row, "id"),
			name: text(row, "name"),
			enabled: row.enabled === true,
			destinationIds: stringList(row, "destination_ids_json"),
			windowMinutes: Number(row.window_minutes),
			lastScheduledAt: epochMs(row, "last_scheduled_at"),
			createdAt: epochMs(row, "created_at") ?? 0,
		})),
		alertRuleStates: (synced.alert_rule_states ?? []).map((row) => ({
			ruleId: text(row, "rule_id"),
			lastEvaluatedAt: epochMs(row, "last_evaluated_at"),
			lastError: nullableText(row, "last_error"),
		})),
		alertDestinations: (synced.alert_destinations ?? []).map((row) => ({
			id: text(row, "id"),
			name: text(row, "name"),
			enabled: row.enabled === true,
			lastTestError: nullableText(row, "last_test_error"),
		})),
		errorNotificationPolicy: null,
		anomalyDetector: null,
		dashboardCount: (synced.dashboards ?? []).length,
		samplingPolicy: null,
		attributeMappings: [],
		clickhouse: null,
		integrations: [],
		cloudflareAnalytics: [],
		vcsRepositories: [],
		scrapeTargets: [],
		openRecommendationCount: 0,
	}
}

const warehouseInputs = (warehouse: FixtureWarehouse, request: EndpointRequest, now: number) =>
	Effect.gen(function* () {
		const orgId = parityOrgId(request.dataset.identity?.orgId ?? "org_parity_signed_out")
		const tenant = warehouse.tenantOf(orgId)
		const window = {
			orgId,
			startTime: formatWarehouseDateTime(now - LOOKBACK_HOURS * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(now),
		}
		const logWindow = {
			orgId,
			startTime: formatWarehouseDateTime(now - Integrations.AUDIT_LOG_CORRELATION_MAX_HOURS * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(now),
		}
		const run = <A>(compiled: CH.CompiledQueryInput<A>, profile: "discovery" | "list") =>
			warehouse.executor.compiledQuery(tenant, compiled, { profile, context: "setupAudit" })
		const results = yield* Effect.all(
			{
				usage: run(CH.compile(CH.serviceUsageQuery({}), window), "discovery"),
				attributeKeys: run(CH.compile(Integrations.auditAttributeKeyInventoryQuery(), window), "discovery"),
				spanShape: run(CH.compile(Integrations.auditSpanProfileByServiceQuery(), window), "list"),
				logSeverity: run(CH.compile(Integrations.auditLogSeverityByServiceQuery(), window), "discovery"),
				metricLabels: run(CH.compile(Integrations.auditMetricLabelCardinalityQuery(), window), "discovery"),
				peerValues: run(CH.compile(Integrations.auditPeerValueInventoryQuery(), window), "discovery"),
				dbEdges: run(CH.compile(Integrations.auditDbEdgeIdentityQuery(), window), "discovery"),
				logCorrelation: run(CH.compile(Integrations.auditLogCorrelationQuery(), logWindow), "list"),
			},
			{ concurrency: 1 },
		)
		const totalSpans = results.spanShape.reduce((sum, row) => sum + row.weightedSpanCount, 0)
		const childEnd = now - TRACE_WINDOW_LAG_MINUTES * 60_000
		const childStart = childEnd - TRACE_WINDOW_MINUTES * 60_000
		const traceWindow = {
			orgId,
			childStart: formatWarehouseDateTime(childStart),
			childEnd: formatWarehouseDateTime(childEnd),
			parentStart: formatWarehouseDateTime(childStart - TRACE_PARENT_LOOKBACK_MINUTES * 60_000),
			traceSampleModulus: Integrations.auditTraceSampleModulus(totalSpans),
		}
		const joined = yield* Effect.all(
			{
				orphans: warehouse.executor.compiledQuery(tenant, Integrations.auditOrphanSpansSQL(traceWindow), {
					profile: "aggregation",
					context: "setupAuditOrphanSpans",
				}),
				rootless: warehouse.executor.compiledQuery(tenant, Integrations.auditRootlessTracesSQL(traceWindow), {
					profile: "aggregation",
					context: "setupAuditRootlessTraces",
				}),
			},
			{ concurrency: 1 },
		)
		const traceCompleteness: TraceCompletenessInputs = {
			windowMinutes: TRACE_WINDOW_MINUTES,
			traceSampleModulus: traceWindow.traceSampleModulus,
			orphans: joined.orphans,
			rootless: joined.rootless,
		}
		const inputs: WarehouseAuditInputs = {
			lookbackHours: LOOKBACK_HOURS,
			logCorrelationHours: Integrations.AUDIT_LOG_CORRELATION_MAX_HOURS,
			traceCompleteness,
			attributeKeys: results.attributeKeys.map((row) => ({ scope: row.scope, key: row.attributeKey, usageCount: row.usageCount })),
			serviceUsage: results.usage.map((row) => ({
				serviceName: row.serviceName,
				logCount: row.totalLogCount,
				traceCount: row.totalTraceCount,
				metricCount:
					row.totalSumMetricCount + row.totalGaugeMetricCount + row.totalHistogramMetricCount + row.totalExpHistogramMetricCount,
			})),
			spanShape: results.spanShape.map((row) => ({
				serviceName: row.serviceName,
				spanCount: row.weightedSpanCount,
				errorCount: row.weightedErrorCount,
				serverCount: row.serverCount,
				consumerCount: row.consumerCount,
				noEnvCount: row.noEnvCount,
				spanNameCount: row.spanNameCount,
				badStatusCodes: row.badStatusCodes,
				badSpanKinds: row.badSpanKinds,
			})),
			logSeverity: results.logSeverity,
			metricLabels: results.metricLabels.map((row) => ({ attributeKey: row.attributeKey, valueCardinality: row.valueCardinality })),
			peerValues: results.peerValues,
			dbEdges: results.dbEdges,
			logCorrelation: results.logCorrelation,
		}
		return inputs
	})

const PUBLIC_ID_PREFIX_BY_KIND: Partial<Record<AuditAffectedEntity["kind"], PublicIdPrefix>> = {
	alert_rule: PublicIdPrefixes.alertRule,
	alert_destination: PublicIdPrefixes.alertDestination,
	attribute_mapping: PublicIdPrefixes.attributeMapping,
	scrape_target: PublicIdPrefixes.scrapeTarget,
}

const toV2 = (report: SetupAuditReport) => ({
	object: "setup_audit",
	generated_at: new Date(report.generatedAt).toISOString(),
	data_status: report.dataStatus,
	telemetry_checks_available: report.warehouseAvailable,
	summary: report.summary,
	checks: report.checks.map((check) => ({
		object: "setup_audit_check",
		id: check.id,
		category: check.category,
		title: check.title,
		severity: check.severity,
		status: check.status,
		detail: check.detail,
		affected: check.affected.map((entity) => {
			const prefix = PUBLIC_ID_PREFIX_BY_KIND[entity.kind]
			return {
				kind: entity.kind,
				id: prefix !== undefined && entity.id !== undefined ? encodePublicId(prefix, entity.id) : null,
				name: entity.name,
				note: entity.note ?? null,
			}
		}),
		affected_count: check.affectedCount,
		fix_hint: check.fixHint,
	})),
	open_recommendation_count: report.openRecommendationCount,
})

/** Onboarding state has no fixture row: an org with data in the window counts as onboarded 30 days ago. */
export const setupAuditEndpoint =
	(warehouse: FixtureWarehouse): EndpointHandler =>
	(request) =>
		Effect.gen(function* () {
			const now = Date.parse(request.dataset.now)
			const telemetry = yield* warehouseInputs(warehouse, request, now).pipe(
				Effect.catchCause(() => Effect.succeed(undefined)),
			)
			const firstDataReceivedAt = telemetry !== undefined && telemetry.serviceUsage.length > 0 ? now - 30 * DAY : null
			return toV2(runSetupAudit({ now, config: configInputs(request, firstDataReceivedAt), warehouse: telemetry }))
		})
