import { cloudflareDatasetUnavailable } from "@maple/domain/cloudflare-analytics"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDestinations,
	AlertRules,
	AlertRuleStates,
	AnomalyDetectorSettings,
	CloudflareAnalyticsState,
	Dashboards,
	ErrorNotificationPolicies,
	OAuthConnections,
	OrgClickHouseSettings,
	OrgIngestAttributeMappings,
	OrgIngestSamplingPolicies,
	OrgOnboardingState,
	OrgRecommendationIssues,
	ScrapeTargets,
	VcsRepositories,
} from "@maple/db/tables"
import { clickHouseSchemaVersion } from "@maple/domain/clickhouse"
import type { OrgId } from "@maple/primitives"
import {
	classifyLogCorrelation,
	type ConfigAuditInputs,
	explodedMetricLabels,
	inventedKeyTwins,
	inventedResourceKeys,
	MAPLE_GENERATED_SERVICE_NAMES,
	MAPLE_INTEGRATION_SERVICE_PREFIXES,
	type TraceCompletenessInputs,
	type WarehouseAuditInputs,
	runSetupAudit,
	sensitiveSpanKeys,
} from "./setup-audit"
import { SetupAuditUnavailableError, type SetupAuditReport } from "@maple/domain/setup-audit"
import { alertRuleIntervalMinutes, CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Cause, Clock, Context, Effect, Layer, Option, Result, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { readOrgCreatedAt } from "@maple/backend/services/org/org-created-at"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"
import * as Integrations from "@maple/query-engine-integrations"
import type { TenantContext } from "@maple/domain/http"

/** Telemetry lookback for the warehouse-backed checks — matches the recommendations reconcile. */
const LOOKBACK_HOURS = 24

/**
 * The trace-completeness joins read one hour, trailing 15 minutes behind now so exporter batching
 * cannot masquerade as a missing parent, with an extra hour of parent lookback for long spans. The
 * orphan join has the hourly service-map rollup's shape and window, which is the cost precedent; the
 * rootless join reads raw `traces` over the same two hours. Do not widen either.
 */
const TRACE_WINDOW_MINUTES = 60
const TRACE_WINDOW_LAG_MINUTES = 15
const TRACE_PARENT_LOOKBACK_MINUTES = 60

/** At most this many keys per attribution read; each becomes one predicate and one count. */
const ATTRIBUTION_MAX_KEYS = 10

/** The release keys RES-02, RES-04 and RES-05 judge per service. */
const RELEASE_RESOURCE_KEYS = ["service.version", "vcs.repository.url.full", "vcs.ref.head.revision"] as const

/** What the ingest sampler keeps from traces it drops; null when it drops nothing. */
const samplingOverrides = (
	policy: ConfigAuditInputs["samplingPolicy"],
): Integrations.AuditSamplingOverrides | null =>
	policy === null || policy.traceSampleRatio >= 1
		? null
		: {
				keepErrorSpans: policy.alwaysKeepErrorSpans,
				slowSpanNs:
					policy.alwaysKeepSlowSpansMs === null ? null : policy.alwaysKeepSlowSpansMs * 1_000_000,
			}

/**
 * Degrades a failed or defective read to `fallback` with a warning, so it costs its checks and not
 * the audit. Interruption still propagates: a cancelled request must not finish as "skipped".
 */
const degradeTo =
	<B>(message: string, context: string, fallback: B) =>
	<A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
		read.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterrupts(cause)
					? Effect.interrupt
					: Effect.logWarning(message).pipe(
							Effect.annotateLogs({ context, cause }),
							Effect.as(fallback),
						),
			),
		)

// Only the field read here, leniently: a tier list in an older or newer shape still names its chains.
const decodeTierChainIds = Schema.decodeUnknownOption(
	Schema.Array(Schema.Struct({ escalationChainId: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
)

/** Escalation chains a rule's tiers start; null `thresholds_json` (pre-tier rules) has none. */
const tierEscalationChainIds = (thresholdsJson: unknown): ReadonlyArray<string> =>
	Option.match(decodeTierChainIds(thresholdsJson), {
		onNone: () => [],
		onSome: (tiers) =>
			Arr.dedupe(Arr.flatMap(tiers, (tier) => Arr.fromNullishOr(tier.escalationChainId))),
	})

export interface SetupAuditServiceApi {
	/** Runs every check against a fresh snapshot of config + telemetry. */
	readonly run: (tenant: TenantContext) => Effect.Effect<SetupAuditReport, SetupAuditUnavailableError>
}

type SetupAuditServiceRequirements =
	| Database
	| WarehouseQueryService
	| IntegrationInventoryService
	| OnboardingService
	| OrganizationService
	| SignalPresenceService

const make: Effect.Effect<SetupAuditServiceApi, never, SetupAuditServiceRequirements> = Effect.gen(
	function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService
		const inventory = yield* IntegrationInventoryService
		const onboarding = yield* OnboardingService
		const organizations = yield* OrganizationService
		const signals = yield* SignalPresenceService

		const dbExecute = makeDbExecute(
			database,
			"SetupAuditService",
			(error) =>
				new SetupAuditUnavailableError({
					message: "Setup audit configuration could not be read",
					operation: "config",
					cause: error,
				}),
		)

		/**
		 * One pass over the org's configuration. Every read is a narrow column projection — the audit
		 * never needs secrets, payloads, or full rows, and keeping the projections narrow is what makes
		 * running ~15 selects per request cheap.
		 */
		const fetchConfigInputs = Effect.fn("SetupAuditService.fetchConfigInputs")(function* (orgId: OrgId) {
			const rows = yield* dbExecute((db) =>
				Effect.gen(function* () {
					const [
						onboarding,
						rules,
						ruleStates,
						destinations,
						notificationPolicy,
						anomalySettings,
						dashboardRows,
						sampling,
						mappings,
						clickhouse,
						connections,
						cloudflare,
						repositories,
						targets,
						openRecommendations,
					] = yield* Effect.all(
						[
							db.run(
								PG.from(OrgOnboardingState)
									.select("firstDataReceivedAt")
									.where(($) => [$.orgId.eq(orgId)])
									.limit(1),
							),
							db.run(
								PG.from(AlertRules)
									.select(($) => ({
										id: $.id,
										name: $.name,
										enabled: $.enabled,
										destinationIdsJson: $.destinationIdsJson,
										// Read leniently: only each tier's escalation chain matters here.
										thresholdsJson: PG.undecoded($.thresholdsJson),
										windowMinutes: $.windowMinutes,
										evaluationIntervalMinutes: $.evaluationIntervalMinutes,
										slowedIntervalMinutes: $.slowedIntervalMinutes,
										lastScheduledAt: $.lastScheduledAt,
										createdAt: $.createdAt,
									}))
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(AlertRuleStates)
									.select("ruleId", "lastEvaluatedAt", "lastError")
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(AlertDestinations)
									.select(
										"id",
										"name",
										"enabled",
										"lastTestError",
										"consecutiveFailures",
										"disabledAt",
										"disabledReason",
									)
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(ErrorNotificationPolicies)
									.select("enabled", "destinationIdsJson")
									.where(($) => [$.orgId.eq(orgId)])
									.limit(1),
							),
							db.run(
								PG.from(AnomalyDetectorSettings)
									.select("enabled")
									.where(($) => [$.orgId.eq(orgId)])
									.limit(1),
							),
							db.run(
								PG.from(Dashboards)
									.select(() => ({ count: PG.count() }))
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(OrgIngestSamplingPolicies)
									.select(
										"traceSampleRatio",
										"alwaysKeepErrorSpans",
										"alwaysKeepSlowSpansMs",
									)
									.where(($) => [$.orgId.eq(orgId)])
									.limit(1),
							),
							db.run(
								PG.from(OrgIngestAttributeMappings)
									.select(
										"id",
										"name",
										"enabled",
										"sourceContext",
										"sourceKey",
										"targetKey",
										"operation",
										"updatedAt",
									)
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(OrgClickHouseSettings)
									.select("syncStatus", "lastSyncError", "schemaVersion")
									.where(($) => [$.orgId.eq(orgId)])
									.limit(1),
							),
							db.run(
								PG.from(OAuthConnections)
									.select("provider", "revokedAt")
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(CloudflareAnalyticsState)
									.select(
										"dataset",
										"settingsJson",
										"zoneName",
										"enabled",
										"lastSuccessAt",
										"lastErrorAt",
										"lastError",
									)
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(VcsRepositories)
									.select("id", "fullName", "syncStatus", "lastSyncError")
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(ScrapeTargets)
									.select("id", "name", "enabled", "lastScrapeError")
									.where(($) => [$.orgId.eq(orgId)]),
							),
							db.run(
								PG.from(OrgRecommendationIssues)
									.select(() => ({ count: PG.count() }))
									.where(($) => [$.orgId.eq(orgId), $.status.eq("open")]),
							),
						],
						{ concurrency: "unbounded" },
					)

					return {
						onboarding,
						rules,
						ruleStates,
						destinations,
						notificationPolicy,
						anomalySettings,
						dashboardRows,
						sampling,
						mappings,
						clickhouse,
						connections,
						cloudflare,
						repositories,
						targets,
						openRecommendations,
					}
				}),
			)

			const clickhouseRow = rows.clickhouse[0]
			// Optional: an unreadable inventory drops the inventory-backed checks to a pass, not the audit.
			const integrationInventory = yield* inventory.list(orgId).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Setup audit could not read integrations", error.message),
				),
				Effect.option,
			)

			const config: ConfigAuditInputs = {
				telemetry: (rows.onboarding[0]?.firstDataReceivedAt ?? null) === null ? "absent" : "present",
				alertRules: Arr.map(rows.rules, (rule) => ({
					id: rule.id,
					name: rule.name,
					enabled: rule.enabled,
					destinationIds: rule.destinationIdsJson ?? [],
					escalationChainIds: tierEscalationChainIds(rule.thresholdsJson),
					windowMinutes: rule.windowMinutes,
					evaluationIntervalMinutes: alertRuleIntervalMinutes(rule),
					lastScheduledAt: rule.lastScheduledAt,
					createdAt: rule.createdAt,
				})),
				alertRuleStates: Arr.map(rows.ruleStates, (state) => ({
					ruleId: state.ruleId,
					lastEvaluatedAt: state.lastEvaluatedAt,
					lastError: state.lastError,
				})),
				alertDestinations: Arr.map(rows.destinations, (destination) => ({
					id: destination.id,
					name: destination.name,
					enabled: destination.enabled,
					lastTestError: destination.lastTestError,
					consecutiveFailures: destination.consecutiveFailures,
					disabledAt: destination.disabledAt,
					disabledReason: destination.disabledReason,
				})),
				errorNotificationPolicy:
					rows.notificationPolicy[0] !== undefined
						? {
								enabled: rows.notificationPolicy[0].enabled,
								destinationIds: rows.notificationPolicy[0].destinationIdsJson ?? [],
							}
						: null,
				anomalyDetector:
					rows.anomalySettings[0] !== undefined
						? { enabled: rows.anomalySettings[0].enabled }
						: null,
				dashboardCount: rows.dashboardRows[0]?.count ?? 0,
				samplingPolicy:
					rows.sampling[0] !== undefined
						? {
								traceSampleRatio: rows.sampling[0].traceSampleRatio,
								alwaysKeepErrorSpans: rows.sampling[0].alwaysKeepErrorSpans,
								alwaysKeepSlowSpansMs: rows.sampling[0].alwaysKeepSlowSpansMs,
							}
						: null,
				attributeMappings: Arr.map(rows.mappings, (mapping) => ({
					id: mapping.id,
					name: mapping.name,
					enabled: mapping.enabled,
					sourceContext: mapping.sourceContext,
					sourceKey: mapping.sourceKey,
					targetKey: mapping.targetKey,
					operation: mapping.operation,
					updatedAt: mapping.updatedAt,
				})),
				clickhouse:
					clickhouseRow !== undefined
						? {
								syncStatus: clickhouseRow.syncStatus,
								lastSyncError: clickhouseRow.lastSyncError,
								schemaVersion: clickhouseRow.schemaVersion,
								expectedSchemaVersion: clickHouseSchemaVersion,
							}
						: null,
				integrations: Arr.map(rows.connections, (connection) => ({
					provider: connection.provider,
					revokedAt: connection.revokedAt,
				})),
				// Datasets disabled by the user are not collected, so a stale error on one is not a finding.
				// Datasets Cloudflare's settings deny stay listed so the check can report them as unavailable.
				cloudflareAnalytics: Arr.map(
					Arr.filter(
						rows.cloudflare,
						(state) => state.enabled || cloudflareDatasetUnavailable(state.settingsJson),
					),
					(state) => ({
						dataset: state.dataset,
						settingsJson: state.settingsJson,
						zoneName: state.zoneName,
						lastSuccessAt: state.lastSuccessAt,
						lastErrorAt: state.lastErrorAt,
						lastError: state.lastError,
					}),
				),
				vcsRepositories: Arr.map(rows.repositories, (repository) => ({
					id: repository.id,
					fullName: repository.fullName,
					syncStatus: repository.syncStatus,
					lastSyncError: repository.lastSyncError,
				})),
				scrapeTargets: Arr.map(rows.targets, (target) => ({
					id: target.id,
					name: target.name,
					enabled: target.enabled,
					lastScrapeError: target.lastScrapeError,
				})),
				openRecommendationCount: rows.openRecommendations[0]?.count ?? 0,
				...(Option.isSome(integrationInventory)
					? { integrationInventory: integrationInventory.value }
					: undefined),
			}

			return config
		})

		/**
		 * The two cross-span joins, over a short lagged window.
		 *
		 * `TRACE_WINDOW_LAG_MINUTES` keeps the window clear of spans still in flight — a span row is
		 * written when the span *ends*, so a parent that is merely slow to export would otherwise read
		 * as missing. `TRACE_PARENT_LOOKBACK_MINUTES` extends only the parent side, because a span's
		 * `Timestamp` is its start and a parent always starts no later than its child.
		 */
		const fetchTraceCompleteness = Effect.fn("SetupAuditService.fetchTraceCompleteness")(function* (
			tenant: TenantContext,
			now: number,
			spanCountOverLookback: number,
			samplingOverrides: Integrations.AuditSamplingOverrides | null,
		) {
			const childEnd = now - TRACE_WINDOW_LAG_MINUTES * 60_000
			const childStart = childEnd - TRACE_WINDOW_MINUTES * 60_000
			const window = {
				orgId: tenant.orgId,
				childStart: formatWarehouseDateTime(childStart),
				childEnd: formatWarehouseDateTime(childEnd),
				parentStart: formatWarehouseDateTime(childStart - TRACE_PARENT_LOOKBACK_MINUTES * 60_000),
				traceSampleModulus: Integrations.auditTraceSampleModulus(spanCountOverLookback),
			}

			// Warm the route before fanning out, so the org-config read happens on an
			// empty connection pool rather than queueing behind a sibling's warehouse
			// fetch. No-op on a warm memo.
			yield* warehouse.warmRoute(tenant)
			// Each join degrades alone: a timed-out rootless scan costs TRC-02, not TRC-01 and TRC-03.
			const orEmpty = <A, E>(context: string, read: Effect.Effect<ReadonlyArray<A>, E>) =>
				read.pipe(degradeTo("Setup audit trace-completeness join skipped", context, []))
			const joined = yield* Effect.all(
				{
					orphans: orEmpty(
						"setupAuditOrphanSpans",
						warehouse.compiledQuery(tenant, Integrations.auditOrphanSpansSQL(window), {
							profile: "aggregation",
							settings: { maxThreads: 4 },
							context: "setupAuditOrphanSpans",
						}),
					),
					rootless: orEmpty(
						"setupAuditRootlessTraces",
						warehouse.compiledQuery(
							tenant,
							Integrations.auditRootlessTracesSQL(window, samplingOverrides),
							{
								profile: "aggregation",
								settings: { maxThreads: 4 },
								context: "setupAuditRootlessTraces",
							},
						),
					),
				},
				{ concurrency: 2 },
			)

			// Names the routes outside callers arrive on, from the trace ids the rootless join sampled.
			const externalRows = Arr.filter(joined.rootless, (row) => row.externalParentCount > 0)
			const externalServices = Arr.map(externalRows, (row) => row.entryService)
			const externalTraceIds = Arr.flatMap(externalRows, (row) => row.externalTraceIds)
			const inboundRoutes =
				Arr.isReadonlyArrayNonEmpty(externalServices) && Arr.isReadonlyArrayNonEmpty(externalTraceIds)
					? yield* orEmpty(
							"setupAuditInboundRoutes",
							warehouse.compiledQuery(
								tenant,
								CH.compile(
									Integrations.auditInboundRoutesQuery(externalServices, externalTraceIds),
									{
										orgId: tenant.orgId,
										parentStart: window.parentStart,
										childEnd: window.childEnd,
									},
								),
								{ profile: "list", context: "setupAuditInboundRoutes" },
							),
						)
					: []

			const inputs: TraceCompletenessInputs = {
				windowMinutes: TRACE_WINDOW_MINUTES,
				traceSampleModulus: window.traceSampleModulus,
				orphans: joined.orphans,
				rootless: Arr.map(joined.rootless, ({ externalTraceIds: _ids, ...row }) => row),
				inboundRoutes,
			}
			return inputs
		})

		/**
		 * Names the services behind keys a check already flagged: invented resource keys (RES-06),
		 * exploded metric labels (MET-01) and sensitive span keys (PII-01). The key rollups carry no
		 * service, so these are raw reads, run only when there is something to attribute and each
		 * capped in keys, window and rows.
		 */
		const fetchKeyAttribution = Effect.fn("SetupAuditService.fetchKeyAttribution")(function* (
			tenant: TenantContext,
			now: number,
			resourceKeys: ReadonlyArray<string>,
			metricKeys: ReadonlyArray<string>,
			sensitiveKeys: ReadonlyArray<string>,
		) {
			const read = <A>(context: string, compiled: CH.CompiledQueryInput<A>) =>
				warehouse
					.compiledQuery(tenant, compiled, { profile: "list", context })
					.pipe(degradeTo("Setup audit key attribution skipped", context, []))
			const window = (hours: number) => ({
				orgId: tenant.orgId,
				startTime: formatWarehouseDateTime(now - hours * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(now),
			})
			const resourceKeyList = Arr.take(resourceKeys, ATTRIBUTION_MAX_KEYS)
			const metricKeyList = Arr.take(metricKeys, ATTRIBUTION_MAX_KEYS)
			const sensitiveKeyList = Arr.take(sensitiveKeys, ATTRIBUTION_MAX_KEYS)
			const twins = inventedKeyTwins(resourceKeyList)
			const none = Effect.succeed([])
			const rows = yield* Effect.all(
				{
					samples: Arr.isReadonlyArrayNonEmpty(resourceKeyList)
						? read(
								"setupAuditResourceKeySamples",
								CH.compile(
									Integrations.auditResourceValueSamplesQuery(resourceKeyList),
									window(LOOKBACK_HOURS),
								),
							)
						: none,
					resourceServices: Arr.isReadonlyArrayNonEmpty(resourceKeyList)
						? read(
								"setupAuditResourceKeyServices",
								CH.compile(
									Integrations.auditResourceKeyServicesQuery(resourceKeyList, {
										duplicatePairs: twins,
									}),
									window(Integrations.AUDIT_RESOURCE_KEY_SERVICE_MAX_HOURS),
								),
							)
						: none,
					sensitiveEmitters: Arr.isReadonlyArrayNonEmpty(sensitiveKeyList)
						? read(
								"setupAuditSensitiveKeyEmitters",
								CH.compile(
									Integrations.auditSensitiveKeyEmittersQuery(sensitiveKeyList),
									window(Integrations.AUDIT_SENSITIVE_KEY_MAX_HOURS),
								),
							)
						: none,
					// `Option.none` when the read failed, so MET-01 falls back to the rollup.
					metricSeries: Arr.isReadonlyArrayNonEmpty(metricKeyList)
						? warehouse
								.compiledQuery(
									tenant,
									CH.compile(
										Integrations.auditMetricLabelByMetricQuery(metricKeyList, {
											collapseServicePrefixes: MAPLE_INTEGRATION_SERVICE_PREFIXES,
										}),
										window(Integrations.AUDIT_METRIC_LABEL_MAX_HOURS),
									),
									{ profile: "list", context: "setupAuditMetricLabelSeries" },
								)
								.pipe(
									Effect.asSome,
									degradeTo(
										"Setup audit key attribution skipped",
										"setupAuditMetricLabelSeries",
										Option.none(),
									),
								)
						: Effect.succeedSome([]),
				},
				{ concurrency: 2 },
			)
			// `keyCounts` is aligned with the keys asked for, `duplicateCounts` with `twins`.
			const resourceKeyServices = Arr.flatMap(rows.resourceServices, (row) =>
				Arr.filterMap(resourceKeyList, (key, index) => {
					if ((row.keyCounts[index] ?? 0) === 0) return Result.failVoid
					const twin = Arr.findFirst(
						twins,
						([invented], pair) => invented === key && (row.duplicateCounts[pair] ?? 0) > 0,
					)
					return Result.succeed(
						Option.match(twin, {
							onNone: () => ({ key, serviceName: row.serviceName }),
							onSome: ([, target]) => ({
								key,
								serviceName: row.serviceName,
								duplicateOf: target,
							}),
						}),
					)
				}),
			)
			const sensitiveKeyEmitters = Arr.flatMap(rows.sensitiveEmitters, (row) =>
				Arr.filterMap(sensitiveKeyList, (key, index) =>
					(row.keyCounts[index] ?? 0) > 0
						? Result.succeed({ key, serviceName: row.serviceName, spanName: row.spanName })
						: Result.failVoid,
				),
			)
			return {
				resourceKeySamples: Arr.map(rows.samples, (row) => ({
					key: row.attributeKey,
					value: row.attributeValue,
					usageCount: row.usageCount,
				})),
				resourceKeyServices,
				sensitiveKeyEmitters,
				...Option.match(rows.metricSeries, {
					onNone: () => ({}),
					onSome: (series) => ({
						// Labels with any row, Maple's folded ones included; MET-01 reports the rest from the rollup.
						metricLabelsMeasured: Arr.filter(metricKeyList, (_key, index) =>
							Arr.some(series, (row) => (row.valueCardinalities[index] ?? 0) > 0),
						),
						// `valueCardinalities` is aligned with the keys asked for.
						metricLabelSeries: Arr.flatMap(series, (row) =>
							Arr.filterMap(metricKeyList, (key, index) => {
								const valueCardinality = row.valueCardinalities[index] ?? 0
								return valueCardinality > 0
									? Result.succeed({
											attributeKey: key,
											serviceName: row.serviceName,
											metricName: row.metricName,
											valueCardinality,
										})
									: Result.failVoid
							}),
						),
					}),
				}),
			} satisfies Pick<
				WarehouseAuditInputs,
				| "resourceKeySamples"
				| "resourceKeyServices"
				| "sensitiveKeyEmitters"
				| "metricLabelSeries"
				| "metricLabelsMeasured"
			>
		})

		/**
		 * Eight core reads (all rollups but the log counts), then the follow-ups that size or target
		 * themselves from them, with the cheap enrichment reads riding beside the trace joins. Capped:
		 * the audit must never behave like a load generator against a warehouse that may be struggling.
		 */
		const fetchWarehouseInputs = Effect.fn("SetupAuditService.fetchWarehouseInputs")(function* (
			tenant: TenantContext,
			samplingOverrides: Integrations.AuditSamplingOverrides | null,
		) {
			const now = yield* Clock.currentTimeMillis
			const window = {
				orgId: tenant.orgId,
				startTime: formatWarehouseDateTime(now - LOOKBACK_HOURS * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(now),
			}
			const logWindow = {
				orgId: tenant.orgId,
				startTime: formatWarehouseDateTime(
					now - Integrations.AUDIT_LOG_CORRELATION_MAX_HOURS * 60 * 60 * 1000,
				),
				endTime: formatWarehouseDateTime(now),
			}

			const run = <A>(compiled: CH.CompiledQueryInput<A>, profile: "discovery" | "list") =>
				warehouse.compiledQuery(tenant, compiled, { profile, context: "setupAudit" })
			// Enrichment reads: a failure costs a classification or a note, never the telemetry half.
			const optional = <A, E>(context: string, read: Effect.Effect<ReadonlyArray<A>, E>) =>
				read.pipe(degradeTo("Setup audit enrichment read skipped", context, []))

			// Like `optional`, but a failure reads as absent so the check can fall back.
			const optionalOption = <A, E>(context: string, read: Effect.Effect<ReadonlyArray<A>, E>) =>
				read.pipe(
					Effect.asSome,
					degradeTo(
						"Setup audit enrichment read skipped",
						context,
						Option.none<ReadonlyArray<A>>(),
					),
				)

			// Same reason as `fetchTraceCompleteness`. Both are independent entry
			// points, so each warms; whichever runs second finds the memo warm and
			// pays nothing.
			yield* warehouse.warmRoute(tenant)
			const results = yield* Effect.all(
				{
					usage: run(CH.compile(CH.serviceUsageQuery({}), window), "discovery"),
					attributeKeys: run(
						CH.compile(Integrations.auditAttributeKeyInventoryQuery(), window),
						"discovery",
					),
					// `list`, not `discovery`: an org whose span names carry IDs — the very thing NAME-02
					// detects — inflates traces_aggregates_hourly past a 5s budget.
					spanShape: run(CH.compile(Integrations.auditSpanProfileByServiceQuery(), window), "list"),
					logSeverity: run(
						CH.compile(Integrations.auditLogSeverityByServiceQuery(), window),
						"discovery",
					),
					metricLabels: run(
						CH.compile(Integrations.auditMetricLabelCardinalityQuery(), window),
						"discovery",
					),
					peerValues: run(
						CH.compile(Integrations.auditPeerValueInventoryQuery(), window),
						"discovery",
					),
					dbEdges: run(CH.compile(Integrations.auditDbEdgeIdentityQuery(), window), "discovery"),
					logCorrelation: run(
						CH.compile(
							Integrations.auditLogCorrelationQuery({
								excludeServiceNames: MAPLE_GENERATED_SERVICE_NAMES,
							}),
							logWindow,
						),
						"list",
					),
				},
				{ concurrency: 4 },
			)

			// Trace completeness is the audit's only cross-span join, so it runs after the cheap reads
			// and sizes its trace sampling from the volume they just reported. It degrades on its own:
			// a join that times out costs the three TRC checks, not the whole telemetry half.
			const totalSpans = Arr.reduce(results.spanShape, 0, (sum, row) => sum + row.weightedSpanCount)
			const attributeKeys = Arr.map(results.attributeKeys, (row) => ({
				scope: row.scope,
				key: row.attributeKey,
				usageCount: row.usageCount,
			}))
			const metricLabels = Arr.map(results.metricLabels, (row) => ({
				attributeKey: row.attributeKey,
				valueCardinality: row.valueCardinality,
			}))
			// Only services quoting a message (LOG-02's "outside any span") need the `Body` follow-up.
			const messageServices = Arr.map(
				classifyLogCorrelation({
					serviceUsage: Arr.map(results.usage, (row) => ({
						serviceName: row.serviceName,
						logCount: row.totalLogCount,
						traceCount: row.totalTraceCount,
						metricCount: 0,
					})),
					logCorrelation: results.logCorrelation,
				}).outside,
				(row) => row.serviceName,
			)
			// The trace joins are the long pole: they start first and the enrichment reads overlap them,
			// with at most six warehouse requests in flight (the joins and attribution run two each).
			const followUps = yield* Effect.all(
				{
					traceCompleteness: fetchTraceCompleteness(
						tenant,
						now,
						totalSpans,
						samplingOverrides,
					).pipe(
						degradeTo(
							"Setup audit trace-completeness checks skipped",
							"setupAuditTraceCompleteness",
							undefined,
						),
					),
					identities: optional(
						"setupAuditServiceIdentity",
						run(CH.compile(Integrations.auditServiceIdentityQuery(), window), "discovery"),
					),
					sdks: optional(
						"setupAuditServiceSdk",
						run(CH.compile(Integrations.auditServiceSdkQuery(), window), "discovery"),
					),
					spanNameTemplates: optionalOption(
						"setupAuditSpanNameTemplates",
						run(CH.compile(Integrations.auditSpanNameTemplatesQuery(), window), "list"),
					),
					logMessages: Arr.isReadonlyArrayNonEmpty(messageServices)
						? optional(
								"setupAuditLogMessages",
								run(
									CH.compile(
										Integrations.auditUncorrelatedLogMessagesQuery(messageServices),
										{
											orgId: tenant.orgId,
											startTime: formatWarehouseDateTime(
												now -
													Integrations.AUDIT_LOG_MESSAGE_MAX_HOURS * 60 * 60 * 1000,
											),
											endTime: formatWarehouseDateTime(now),
										},
									),
									"list",
								),
							)
						: Effect.succeed([]),
					attribution: fetchKeyAttribution(
						tenant,
						now,
						inventedResourceKeys(attributeKeys),
						explodedMetricLabels(metricLabels),
						sensitiveSpanKeys(attributeKeys),
					),
					// Trace-sampled from the same span volume, scaled to this read's longer window.
					resourceKeys: optionalOption(
						"setupAuditServiceResourceKeys",
						run(
							CH.compile(
								Integrations.auditServiceResourceKeysQuery(RELEASE_RESOURCE_KEYS, {
									traceSampleModulus:
										Integrations.auditServiceResourceSampleModulus(totalSpans),
								}),
								{
									orgId: tenant.orgId,
									startTime: formatWarehouseDateTime(
										now - Integrations.AUDIT_SERVICE_RESOURCE_MAX_HOURS * 60 * 60 * 1000,
									),
									endTime: formatWarehouseDateTime(now),
								},
							),
							"list",
						),
					),
				},
				{ concurrency: 4 },
			)
			const traceCompleteness = followUps.traceCompleteness
			const sdkByService = new Map(
				Arr.map(followUps.sdks, (row) => [row.serviceName, row.sdkLanguages] as const),
			)
			const messageByService = new Map(
				Arr.flatMap(followUps.logMessages, (row) =>
					Arr.map(Arr.take(row.topMessages, 1), (message) => [row.serviceName, message] as const),
				),
			)

			const inputs: WarehouseAuditInputs = {
				lookbackHours: LOOKBACK_HOURS,
				logCorrelationHours: Integrations.AUDIT_LOG_CORRELATION_MAX_HOURS,
				traceCompleteness,
				attributeKeys,
				serviceUsage: Arr.map(results.usage, (row) => ({
					serviceName: row.serviceName,
					logCount: row.totalLogCount,
					traceCount: row.totalTraceCount,
					metricCount:
						row.totalSumMetricCount +
						row.totalGaugeMetricCount +
						row.totalHistogramMetricCount +
						row.totalExpHistogramMetricCount,
				})),
				spanShape: Arr.map(results.spanShape, (row) => ({
					serviceName: row.serviceName,
					spanCount: row.weightedSpanCount,
					errorCount: row.weightedErrorCount,
					serverCount: row.serverCount,
					consumerCount: row.consumerCount,
					noEnvCount: row.noEnvCount,
					spanNameCount: row.spanNameCount,
					badStatusCodes: row.badStatusCodes,
					badSpanKinds: row.badSpanKinds,
					...Arr.match(row.rootSpanNames, {
						onEmpty: () => ({}),
						onNonEmpty: ([first]) => ({ rootSpanName: first }),
					}),
					...Arr.match(row.rootSpanKinds, {
						onEmpty: () => ({}),
						onNonEmpty: ([first]) => ({ rootSpanKind: first }),
					}),
				})),
				logSeverity: results.logSeverity,
				metricLabels,
				peerValues: results.peerValues,
				dbEdges: results.dbEdges,
				...Option.match(followUps.spanNameTemplates, {
					onNone: () => ({}),
					onSome: (rows) => ({ spanNameTemplates: rows }),
				}),
				...Option.match(followUps.resourceKeys, {
					onNone: () => ({}),
					onSome: (rows) => ({
						serviceResourceKeys: Arr.map(rows, (row) => ({
							serviceName: row.serviceName,
							keys: Arr.filter(
								RELEASE_RESOURCE_KEYS,
								(_key, index) => (row.keyCounts[index] ?? 0) > 0,
							),
						})),
					}),
				}),
				logCorrelation: Arr.map(results.logCorrelation, (row) => ({
					serviceName: row.serviceName,
					logCount: row.logCount,
					uncorrelatedCount: row.uncorrelatedCount,
					errorLogCount: row.errorLogCount,
					uncorrelatedErrorCount: row.uncorrelatedErrorCount,
					numberedOddSeverities: row.numberedOddSeverities,
					unnumberedOddSeverities: row.unnumberedOddSeverities,
					...Option.match(Option.fromUndefinedOr(messageByService.get(row.serviceName)), {
						onNone: () => ({}),
						onSome: (message) => ({ topUncorrelatedMessage: message }),
					}),
				})),
				services: Arr.map(followUps.identities, (row) => ({
					serviceName: row.serviceName,
					namespaces: row.namespaces,
					environments: row.environments,
					sdkLanguages: sdkByService.get(row.serviceName) ?? [],
				})),
				...followUps.attribution,
			}
			return inputs
		})

		/**
		 * `firstDataReceivedAt` has no ingest-side writer, so an unstamped org is checked against the
		 * warehouse (same predicate as the onboarding checklist) and stamped here. `unavailable`
		 * leaves the row unstamped so the next run probes again.
		 */
		const resolveTelemetry = Effect.fn("SetupAuditService.resolveTelemetry")(function* (
			tenant: TenantContext,
			recorded: ConfigAuditInputs["telemetry"],
		) {
			if (recorded === "present") return recorded
			const report = yield* signals.read(tenant)
			const hasTelemetry = Arr.some(
				report.signals,
				(signal) =>
					signal.status === "present" &&
					(signal.signal === "traces" || signal.signal === "logs" || signal.signal === "metrics"),
			)
			const probe: ConfigAuditInputs["telemetry"] = report.warehouseAvailable
				? hasTelemetry
					? "present"
					: "absent"
				: "unavailable"
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.audit.first_data_probe": probe })
			if (probe !== "present") return probe

			// A failed write must not hide the audit from an org that has data; the next run retries.
			const stamped = yield* onboarding
				.recordFirstDataReceived(tenant.orgId, readOrgCreatedAt(organizations, tenant.orgId))
				.pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Setup audit could not stamp first data received", error.message),
					),
					Effect.orElseSucceed(() => false),
				)
			yield* Effect.annotateCurrentSpan({ "maple.audit.first_data_stamped": stamped })
			return probe
		})

		const run = Effect.fn("SetupAuditService.run")(function* (tenant: TenantContext) {
			const recorded = yield* fetchConfigInputs(tenant.orgId)
			const config: ConfigAuditInputs = {
				...recorded,
				telemetry: yield* resolveTelemetry(tenant, recorded.telemetry),
			}

			// A warehouse outage must not take the whole audit down — the configuration half is the
			// part that most often explains "why didn't anything page me", and it is always readable.
			// `degradeTo` covers defects too: a driver-level defect degrades to skipped checks, not a 500.
			// The presence probe already found the warehouse unreachable: skip the telemetry checks.
			const warehouseInputs =
				config.telemetry === "unavailable"
					? undefined
					: yield* fetchWarehouseInputs(tenant, samplingOverrides(config.samplingPolicy)).pipe(
							degradeTo(
								"Setup audit telemetry checks skipped: warehouse unavailable",
								"setupAuditWarehouse",
								undefined,
							),
						)

			const now = yield* Clock.currentTimeMillis
			const report = runSetupAudit({ now, config, warehouse: warehouseInputs })

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.audit.data_status": report.dataStatus,
				"maple.audit.warehouse_available": report.warehouseAvailable,
				"maple.audit.critical": report.summary.critical,
				"maple.audit.warn": report.summary.warn,
				"maple.audit.info": report.summary.info,
				"maple.audit.skip": report.summary.skip,
			})

			return report
		})

		return { run } satisfies SetupAuditServiceApi
	},
)

export class SetupAuditService extends Context.Service<SetupAuditService, SetupAuditServiceApi>()(
	"@maple/backend/services/SetupAuditService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				WarehouseQueryService.layer,
				IntegrationInventoryService.layer,
				OnboardingService.layer,
				OrganizationService.layer,
				SignalPresenceService.layer,
			),
		),
	)
}
