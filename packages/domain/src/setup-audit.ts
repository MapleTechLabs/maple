// Audits an org's Maple setup and reports what is broken or missing. Pure and dependency-free so it
// runs identically in the API (apps/api/src/services/SetupAuditService.ts), in the MCP tool, and in
// unit tests — same shape as `./recommendations`.
//
// Architecture: fetch-once → pure evaluation. One IO pass populates `SetupAuditInputs`; every check is
// a pure function over it. Checks share inputs heavily (alert rules + destinations feed four checks),
// and warehouse degradation becomes ONE decision instead of N: when `inputs.warehouse` is undefined,
// every `needsWarehouse` check emits `skip` and the report still returns the config findings.
//
// Severity is fixed per check, never computed inside `evaluate`. Conditional severity ("critical if
// referenced, warn otherwise") is a smell — split it into two checks or pick the honest one. The
// exceptions are tiered readings of one condition (TRC-02's rate; LOG-02's "no correlation at all"
// versus "mostly outside spans"): one check, whose evaluation names the tier it crossed.
//
// Checks deliberately NOT included, so nobody re-adds them: escalation policy disabled (defaults to
// false — would fire on nearly every org), AI triage disabled (opt-in by design), no scrape targets /
// no VCS repo / no integrations (absence of an optional feature is not a finding), destination never
// tested (delivery works fine without ever pressing Test), onboarding checklist incomplete (owned by
// the onboarding surface). A check that fires on every healthy org is noise, not an audit.

import { Option, Order, pipe, Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { HttpTaggedError } from "./http/error-policy"
import {
	type IntegrationEntry,
	type IntegrationInventory,
	type IntegrationResource,
	PLANETSCALE_NO_ORGANIZATION_PROBLEM,
	summarizeResources,
} from "./integration-inventory"
import { HYPERDRIVE_DB_NAMESPACE } from "./tinybird/db-query-shape-sql"
import { isMapleService, UPTIME_SERVICE_NAME } from "./uptime"

export class SetupAuditUnavailableError extends HttpTaggedError<SetupAuditUnavailableError>()(
	"@maple/http/errors/SetupAuditUnavailableError",
	{
		message: Schema.String,
		operation: Schema.String,
		cause: Schema.Defect(),
	},
	{
		status: 503,
		code: "setup_audit_unavailable",
		title: "Setup audit is temporarily unavailable",
		message: "The setup audit is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export type AuditSeverity = "critical" | "warn" | "info"
export type AuditStatus = "pass" | "fail" | "skip"

export type AuditCategory =
	| "alerting"
	| "notifications"
	| "ingestion"
	| "attributes"
	| "traces"
	| "integrations"
	| "data_platform"

/** A concrete thing a finding points at, so the UI can chip it and deep-link to its editor. */
export interface AuditAffectedEntity {
	readonly kind:
		| "service"
		| "alert_rule"
		| "alert_destination"
		| "attribute_mapping"
		| "scrape_target"
		| "repository"
		| "integration"
		| "attribute_key"
	/** Internal id when the entity has one; encoded to a public id at the wire boundary. */
	readonly id?: string
	readonly name: string
	/** Per-entity evidence, e.g. `last error: timeout after 5s`. */
	readonly note?: string
}

export interface AuditEvaluation {
	readonly status: "pass" | "fail"
	/** Human sentence describing the finding. Omitted on pass. */
	readonly detail?: string
	readonly affected?: ReadonlyArray<AuditAffectedEntity>
	/** Total affected before capping; defaults to `affected.length`. */
	readonly affectedCount?: number
	/** The tier a tiered-rate check crossed; defaults to the check's own severity. */
	readonly severity?: AuditSeverity
	/** A fix that fits this finding better than the check's generic `fixHint`. */
	readonly fixHint?: string
}

export interface AuditCheck {
	/** Stable, human-readable id — `CFG-ALERT-03`. Doubles as the wire identifier. */
	readonly id: string
	readonly category: AuditCategory
	readonly title: string
	readonly severity: AuditSeverity
	/** When true and `inputs.warehouse` is undefined, the runner emits `skip` without evaluating. */
	readonly needsWarehouse?: boolean
	readonly fixHint: string
	readonly evaluate: (inputs: SetupAuditInputs) => AuditEvaluation
}

export interface AuditCheckResult {
	readonly id: string
	readonly category: AuditCategory
	readonly title: string
	readonly severity: AuditSeverity
	readonly status: AuditStatus
	readonly detail: string | null
	readonly affected: ReadonlyArray<AuditAffectedEntity>
	readonly affectedCount: number
	readonly fixHint: string
}

export interface SetupAuditSummary {
	readonly critical: number
	readonly warn: number
	readonly info: number
	readonly pass: number
	readonly skip: number
}

export interface SetupAuditReport {
	readonly generatedAt: number
	/** `no_data` short-circuits the whole report — see `runSetupAudit`. */
	readonly dataStatus: "ok" | "no_data"
	readonly warehouseAvailable: boolean
	readonly summary: SetupAuditSummary
	readonly checks: ReadonlyArray<AuditCheckResult>
	readonly openRecommendationCount: number
}

// Inputs
//
// Flat readonly structs of exactly the fields the checks read — never Drizzle row types or ClickHouse
// row shapes. That boundary is what keeps this module driver-free and its tests infra-free.

export interface AuditAlertRule {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly destinationIds: ReadonlyArray<string>
	/** Escalation chains the rule's tiers start; a chain pages on-call people on its own. */
	readonly escalationChainIds: ReadonlyArray<string>
	readonly windowMinutes: number
	/** Effective minutes between checks: picked, derived from the window, or slowed by the scheduler. */
	readonly evaluationIntervalMinutes: number
	/** Heartbeat stamped when the scheduler claims the rule, so it advances once per interval. */
	readonly lastScheduledAt: number | null
	readonly createdAt: number
}

export interface AuditAlertRuleState {
	readonly ruleId: string
	readonly lastEvaluatedAt: number | null
	readonly lastError: string | null
}

export interface AuditAlertDestination {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly lastTestError: string | null
	/** Terminal delivery failures in a row; any successful delivery resets it. */
	readonly consecutiveFailures: number
	/** Set when Maple turned the destination off after repeated failures (or its last recipient left). */
	readonly disabledAt: number | null
	readonly disabledReason: string | null
}

export interface AuditAttributeMapping {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly sourceContext: string
	readonly sourceKey: string
	readonly targetKey: string
	/** `copy` keeps the source key on the span; `move` deletes it once the target is written. */
	readonly operation: string
	/** Epoch ms of the last change; spans stored before it predate the current rule. */
	readonly updatedAt: number
}

export interface ConfigAuditInputs {
	/**
	 * Whether the org has ever received telemetry; gates the whole report. `absent` short-circuits to
	 * `no_data`; `unavailable` (the warehouse could not answer) runs the config checks only.
	 */
	readonly telemetry: "present" | "absent" | "unavailable"
	readonly alertRules: ReadonlyArray<AuditAlertRule>
	readonly alertRuleStates: ReadonlyArray<AuditAlertRuleState>
	readonly alertDestinations: ReadonlyArray<AuditAlertDestination>
	/** Missing row means Maple defaults: enabled, but with no destinations. */
	readonly errorNotificationPolicy: {
		readonly enabled: boolean
		readonly destinationIds: ReadonlyArray<string>
	} | null
	/** Missing row means enabled — the detector is zero-config. */
	readonly anomalyDetector: { readonly enabled: boolean } | null
	readonly dashboardCount: number
	/** Missing row means no sampling (ratio 1). */
	readonly samplingPolicy: {
		readonly traceSampleRatio: number
		readonly alwaysKeepErrorSpans: boolean
		readonly alwaysKeepSlowSpansMs: number | null
	} | null
	readonly attributeMappings: ReadonlyArray<AuditAttributeMapping>
	/** Null when the org is on managed Tinybird rather than BYO ClickHouse. */
	readonly clickhouse: {
		readonly syncStatus: string
		readonly lastSyncError: string | null
		readonly schemaVersion: string | null
		readonly expectedSchemaVersion: string
	} | null
	readonly integrations: ReadonlyArray<{ readonly provider: string; readonly revokedAt: number | null }>
	readonly cloudflareAnalytics: ReadonlyArray<{
		readonly dataset: string
		readonly zoneName: string | null
		readonly lastSuccessAt: number | null
		readonly lastErrorAt: number | null
		readonly lastError: string | null
	}>
	readonly vcsRepositories: ReadonlyArray<{
		readonly id: string
		readonly fullName: string
		readonly syncStatus: string
		readonly lastSyncError: string | null
	}>
	readonly scrapeTargets: ReadonlyArray<{
		readonly id: string
		readonly name: string
		readonly enabled: boolean
		readonly lastScrapeError: string | null
	}>
	readonly openRecommendationCount: number
	/**
	 * Every connected integration with its derived health (`buildIntegrationInventory`), for the
	 * providers the narrower inputs above do not cover. Absent when it could not be read.
	 */
	readonly integrationInventory?: IntegrationInventory
}

export interface AuditAttributeKey {
	/** `span` | `resource` | `log` | `metric`. */
	readonly scope: string
	readonly key: string
	readonly usageCount: number
}

export interface AuditServiceUsage {
	readonly serviceName: string
	readonly logCount: number
	readonly traceCount: number
	readonly metricCount: number
}

export interface AuditSpanProfile {
	readonly serviceName: string
	readonly spanCount: number
	readonly errorCount: number
	readonly serverCount: number
	readonly consumerCount: number
	readonly noEnvCount: number
	readonly spanNameCount: number
	readonly badStatusCodes: ReadonlyArray<string>
	readonly badSpanKinds: ReadonlyArray<string>
	/** The busiest root span that is not Server/Consumer, and its kind, when there is one. */
	readonly rootSpanName?: string
	readonly rootSpanKind?: string
}

export interface AuditLogCorrelation {
	readonly serviceName: string
	readonly logCount: number
	readonly uncorrelatedCount: number
	readonly errorLogCount: number
	readonly uncorrelatedErrorCount: number
	/** Raw prefix of the commonest log body without trace context; redacted before it is shown. */
	readonly topUncorrelatedMessage?: string
	/** Non-standard severity texts seen with a valid OTel `SeverityNumber` (1-24), and without one. */
	readonly numberedOddSeverities?: ReadonlyArray<string>
	readonly unnumberedOddSeverities?: ReadonlyArray<string>
}

/** What the rollups say about one traced service, for telling who can fix its telemetry. */
export interface AuditServiceIdentity {
	readonly serviceName: string
	/** Non-empty `service.namespace` values. */
	readonly namespaces: ReadonlyArray<string>
	/** Non-empty deployment environments. */
	readonly environments: ReadonlyArray<string>
	/** Non-empty `telemetry.sdk.language` values. */
	readonly sdkLanguages: ReadonlyArray<string>
}

export interface AuditMetricLabelSeries {
	readonly attributeKey: string
	readonly serviceName: string
	readonly metricName: string
	readonly valueCardinality: number
}

export interface AuditSpanNameTemplates {
	readonly serviceName: string
	readonly rawNameCount: number
	/** Distinct names once UUIDs, hex runs, `prefix_<id>`s and digit runs are templated out. */
	readonly templateCount: number
	/** Raw names behind the busiest template, and up to three of them. */
	readonly topTemplateNameCount: number
	readonly exampleNames: ReadonlyArray<string>
}

export interface AuditServiceResourceKeys {
	readonly serviceName: string
	/** The resource keys seen on any of the service's entry spans. */
	readonly keys: ReadonlyArray<string>
}

/**
 * Telemetry-derived inputs. `undefined` on `SetupAuditInputs` means the warehouse was unreachable and
 * every `needsWarehouse` check skips.
 *
 * THE SEAM: new warehouse checks extend this interface and the fetcher in SetupAuditService; the check
 * bodies below stay pure.
 */
export interface WarehouseAuditInputs {
	readonly lookbackHours: number
	/** Every attribute key observed over the lookback window, tagged with its scope. */
	readonly attributeKeys: ReadonlyArray<AuditAttributeKey>
	/** Per-service signal volumes — the answer to "what is this service actually sending". */
	readonly serviceUsage: ReadonlyArray<AuditServiceUsage>
	readonly spanShape: ReadonlyArray<AuditSpanProfile>
	readonly logSeverity: ReadonlyArray<{
		readonly serviceName: string
		readonly severityText: string
		readonly logCount: number
	}>
	readonly metricLabels: ReadonlyArray<{
		readonly attributeKey: string
		readonly valueCardinality: number
	}>
	readonly peerValues: ReadonlyArray<{
		readonly attributeKey: string
		readonly attributeValue: string
		readonly usageCount: number
	}>
	/** Database calls per namespace, as the service map keys its database nodes. */
	readonly dbEdges: ReadonlyArray<{
		readonly serviceName: string
		readonly dbSystem: string
		/** Empty, the `hyperdrive` sentinel and host fallbacks included. */
		readonly dbNamespace: string
		readonly callCount: number
	}>
	/** Log correlation is sampled over a shorter window than the rest — see `logCorrelationHours`. */
	readonly logCorrelation: ReadonlyArray<AuditLogCorrelation>
	readonly logCorrelationHours: number
	/** Identity of each traced service; classifies Maple-written and client services. */
	readonly services: ReadonlyArray<AuditServiceIdentity>
	/** Top values of the invented resource keys present (see {@link inventedResourceKeys}). */
	readonly resourceKeySamples: ReadonlyArray<{
		readonly key: string
		readonly value: string
		readonly usageCount: number
	}>
	/**
	 * Services seen emitting each invented resource key, from a short recent window. `duplicateOf`
	 * names a semconv key the same service already sends with the same value.
	 */
	readonly resourceKeyServices: ReadonlyArray<{
		readonly key: string
		readonly serviceName: string
		readonly duplicateOf?: string
	}>
	/** Service and span name behind each sensitive-looking span key (see {@link sensitiveSpanKeys}). */
	readonly sensitiveKeyEmitters?: ReadonlyArray<{
		readonly key: string
		readonly serviceName: string
		readonly spanName: string
	}>
	/**
	 * Per-metric cardinality of each label the rollup flagged (see {@link explodedMetricLabels}), from
	 * a short recent window. Absent when that read failed, and MET-01 falls back to the rollup.
	 */
	readonly metricLabelSeries?: ReadonlyArray<AuditMetricLabelSeries>
	/** Labels the per-metric read saw at all (any service, Maple's included); absent with the read. */
	readonly metricLabelsMeasured?: ReadonlyArray<string>
	/** Distinct span names against ID-free templates, per service. Absent when the read failed. */
	readonly spanNameTemplates?: ReadonlyArray<AuditSpanNameTemplates>
	/** Release resource keys each traced service sets. Absent when the read failed. */
	readonly serviceResourceKeys?: ReadonlyArray<AuditServiceResourceKeys>
	/**
	 * Trace-completeness samples. These come from a short, lagged window and (on high-volume orgs) a
	 * fraction of traces, so they are rates to reason about — never exact counts.
	 */
	readonly traceCompleteness: TraceCompletenessInputs | undefined
}

export interface TraceCompletenessInputs {
	/** Length of the sampled window, in minutes. */
	readonly windowMinutes: number
	/** 1 = every trace examined; N = one in N. */
	readonly traceSampleModulus: number
	readonly orphans: ReadonlyArray<{
		readonly serviceName: string
		readonly childCount: number
		readonly orphanCount: number
		/** Orphans inside sampling-marked traces, where a missing parent is expected. */
		readonly sampledOrphanCount: number
		/** Unsampled orphans in traces with no root in the org: the caller is outside it. */
		readonly externalParentCount: number
		readonly sampleTraceIds: ReadonlyArray<string>
	}>
	readonly rootless: ReadonlyArray<{
		readonly entryService: string
		readonly traceCount: number
		readonly rootlessCount: number
		readonly sampledRootlessCount: number
		/** Unsampled rootless traces entered by a Server/Consumer span carrying an outside parent. */
		readonly externalParentCount: number
		/** Org-wide totals, the same on every row; they include services past the row cap. */
		readonly orgTraceCount: number
		readonly orgRootlessCount: number
		readonly orgSampledRootlessCount: number
		readonly orgExternalParentCount: number
	}>
	/** The routes a sample of external-parent traces entered by, busiest first. */
	readonly inboundRoutes: ReadonlyArray<{
		readonly serviceName: string
		readonly route: string
		readonly traceCount: number
	}>
}

export interface SetupAuditInputs {
	readonly now: number
	readonly config: ConfigAuditInputs
	readonly warehouse: WarehouseAuditInputs | undefined
}

// Helpers

/** How many affected entities a single finding carries; the rest are counted, not listed. */
export const AUDIT_AFFECTED_LIMIT = 20
const AFFECTED_LIMIT = AUDIT_AFFECTED_LIMIT

/** Floor for how old an enabled rule's scheduler claim may get before it counts as stalled. */
const RULE_SCHEDULE_STALE_FLOOR_MS = 30 * 60_000
/** A claim older than this has missed at least one full interval, not just a slow tick. */
const ruleScheduleStaleMs = (intervalMinutes: number): number =>
	Math.max(RULE_SCHEDULE_STALE_FLOOR_MS, 2 * intervalMinutes * 60_000)
/** Grace period before a never-scheduled rule counts as broken rather than brand new. */
const RULE_NEVER_SCHEDULED_GRACE_MS = 2 * 60 * 60_000
/** Max characters of a provider error quoted into a finding, ellipsis included. */
const ERROR_EXCERPT_LIMIT = 160

const PASS: AuditEvaluation = { status: "pass" }

const fail = (detail: string, affected: ReadonlyArray<AuditAffectedEntity> = []): AuditEvaluation => ({
	status: "fail",
	detail,
	affected: affected.slice(0, AFFECTED_LIMIT),
	affectedCount: affected.length,
})

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
	`${count} ${count === 1 ? singular : pluralForm}`

/**
 * Subject-verb agreement for finding sentences, which always lead with a count. Without it every
 * multi-item finding reads as "3 services emits …".
 */
const conj = (count: number, singular: string, pluralForm: string) => (count === 1 ? singular : pluralForm)

const formatAgo = (ms: number): string => {
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 60) return plural(Math.max(minutes, 1), "minute")
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return plural(hours, "hour")
	return plural(Math.floor(hours / 24), "day")
}

/** Truncates a provider error so one pathological message can't dominate the report. */
const briefError = (message: string): string =>
	message.length > ERROR_EXCERPT_LIMIT ? `${Str.slice(0, ERROR_EXCERPT_LIMIT - 1)(message)}…` : message

const percent = (numerator: number, denominator: number): string =>
	denominator === 0 ? "0%" : `${Math.round((numerator / denominator) * 100)}%`

/** Like `percent`, with two significant digits below 10% so a 0.1% threshold reads as one. */
const sharePercent = (numerator: number, denominator: number): string => {
	const share = denominator === 0 ? 0 : (numerator / denominator) * 100
	return share >= 10 ? `${Math.round(share)}%` : `${Number(share.toPrecision(2))}%`
}

const keysForScope = (warehouse: WarehouseAuditInputs, scope: string): Set<string> =>
	new Set(
		Arr.map(
			Arr.filter(warehouse.attributeKeys, (row) => row.scope === scope),
			(row) => row.key,
		),
	)

const spanKeySet = (warehouse: WarehouseAuditInputs): Set<string> => keysForScope(warehouse, "span")

/**
 * Reports the services that set none of `keys` on their resource. Only services of the given
 * origins are judged; without per-service rows it falls back to "no resource in the org has the key".
 */
const resourceKeyCheck = (
	id: string,
	title: string,
	keys: ReadonlyArray<string>,
	detail: { readonly org: string; readonly services: (count: number) => string },
	fixHint: string,
	origins: ReadonlySet<AuditServiceOrigin> = new Set(["app", "client"]),
): AuditCheck => ({
	id,
	category: "attributes",
	title,
	severity: "warn",
	needsWarehouse: true,
	fixHint,
	evaluate: ({ warehouse }) => {
		if (!warehouse) return PASS
		const present = keysForScope(warehouse, "resource")
		const perService = warehouse.serviceResourceKeys
		// No rows (metrics-only org, no entry span in the window) judges nothing, so fall back too.
		if (perService === undefined || perService.length === 0)
			return Arr.some(keys, (key) => present.has(key)) ? PASS : fail(detail.org)
		const origin = serviceOrigin(warehouse)
		const missing = Arr.map(
			Arr.filter(
				perService,
				(service) =>
					origins.has(origin(service.serviceName)) &&
					!Arr.some(keys, (key) => service.keys.includes(key)),
			),
			(service) => ({
				kind: "service" as const,
				name: service.serviceName,
				note: `no \`${Arr.join(keys, "` or `")}\` on its resource`,
			}),
		)
		return missing.length === 0 ? PASS : fail(detail.services(missing.length), missing)
	},
})

// Checks

/**
 * A failure streak worth reporting on an enabled destination: one short of the 3 at which
 * `AlertsService` turns it off, so a single transient failure stays quiet.
 */
const DESTINATION_FAILING_STREAK = 2

/** Off because Maple turned it off (failed deliveries, last recipient left), not an admin. */
const isAutoDisabled = (destination: AuditAlertDestination): boolean =>
	!destination.enabled && destination.disabledAt !== null

/** Why a destination is not delivering, or null when nothing says it is broken. */
const destinationFailureNote = (destination: AuditAlertDestination, now: number): string | null => {
	if (isAutoDisabled(destination)) {
		const reason =
			destination.disabledReason === null ? "" : `: ${briefError(destination.disabledReason)}`
		return `turned off by Maple ${formatAgo(now - (destination.disabledAt ?? now))} ago${reason}`
	}
	if (!destination.enabled) return null
	if (destination.consecutiveFailures >= DESTINATION_FAILING_STREAK) {
		const test =
			destination.lastTestError === null ? "" : `; last test: ${briefError(destination.lastTestError)}`
		return `${plural(destination.consecutiveFailures, "delivery", "deliveries")} in a row failed${test}`
	}
	return destination.lastTestError === null
		? null
		: `last test failed: ${briefError(destination.lastTestError)}`
}

const alertingChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-ALERT-01",
		category: "alerting",
		title: "At least one notification destination is enabled",
		severity: "critical",
		fixHint: "Add a destination in Alerts → Routing (Slack, PagerDuty, webhook, email, …).",
		evaluate: ({ config }) =>
			Arr.some(config.alertDestinations, (destination) => destination.enabled)
				? PASS
				: fail(
						"No enabled notification destinations. Alert rules, error notifications and escalations all deliver through destinations, so every notification is silently dropped.",
					),
	},
	{
		id: "CFG-ALERT-02",
		category: "alerting",
		title: "At least one alert rule is defined",
		severity: "warn",
		fixHint:
			"Create a rule in Alerts → Rules, starting with error rate or p95 latency on your busiest service.",
		evaluate: ({ config }) => {
			if (Arr.some(config.alertRules, (rule) => rule.enabled)) return PASS
			// A missing settings row means the detector is on — see the schema comment on
			// anomaly_detector_settings.
			const anomalyOn = config.anomalyDetector === null || config.anomalyDetector.enabled
			return fail(
				anomalyOn
					? "No enabled alert rules. Anomaly detection is on and will catch sudden shifts, but it can't enforce the thresholds your SLOs actually care about."
					: "No enabled alert rules, and anomaly detection is also disabled. Nothing will notify you when a service degrades.",
			)
		},
	},
	{
		id: "CFG-ALERT-03",
		category: "alerting",
		title: "Every enabled alert rule routes somewhere",
		severity: "critical",
		fixHint:
			"Open each rule and pick at least one enabled destination or an escalation chain under Notifications. A destination Maple turned off after failed deliveries needs its config fixed and re-enabling in Alerts → Routing.",
		evaluate: ({ config }) => {
			const destinationsById = new Map(Arr.map(config.alertDestinations, (d) => [d.id, d] as const))
			const enabledRules = Arr.filter(config.alertRules, (rule) => rule.enabled)
			const broken = Arr.flatMap(enabledRules, (rule): Array<AuditAffectedEntity> => {
				// An escalation chain pages its own targets (people, schedules), so the rule reaches someone.
				if (rule.escalationChainIds.length > 0) return []
				const selected = Arr.flatMap(rule.destinationIds, (id) =>
					Arr.fromNullishOr(destinationsById.get(id)),
				)
				if (Arr.some(selected, (d) => d.enabled)) return []
				const autoDisabled = Arr.filter(selected, isAutoDisabled)
				const note =
					rule.destinationIds.length === 0
						? "no destinations selected"
						: autoDisabled.length > 0
							? `every selected destination is off; Maple turned off ${Arr.join(
									Arr.map(autoDisabled, (d) =>
										d.disabledReason === null
											? d.name
											: `${d.name} (${briefError(d.disabledReason)})`,
									),
									", ",
								)}`
							: "every selected destination is disabled or deleted"
				return [{ kind: "alert_rule", id: rule.id, name: rule.name, note }]
			})
			return broken.length === 0
				? PASS
				: fail(
						`${plural(broken.length, "enabled alert rule")} will evaluate and breach but deliver to nobody.`,
						broken,
					)
		},
	},
	{
		id: "CFG-ALERT-04",
		category: "alerting",
		title: "Notification destinations are delivering",
		severity: "warn",
		fixHint:
			"Open the destination in Alerts → Routing, fix its URL, token or channel, then send a test; saving the fix turns an auto-disabled destination back on.",
		evaluate: ({ config, now }) => {
			const failing = Arr.flatMap(
				config.alertDestinations,
				(destination): Array<AuditAffectedEntity> => {
					const note = destinationFailureNote(destination, now)
					return note === null
						? []
						: [{ kind: "alert_destination", id: destination.id, name: destination.name, note }]
				},
			)
			return failing.length === 0
				? PASS
				: fail(
						`${plural(failing.length, "destination")} ${conj(failing.length, "is", "are")} failing to deliver, or ${conj(failing.length, "was", "were")} turned off by Maple.`,
						failing,
					)
		},
	},
	{
		id: "CFG-ALERT-05",
		category: "alerting",
		title: "Enabled alert rules are actually being evaluated",
		severity: "critical",
		fixHint:
			"Check the rule's query and filters; a rule that never evaluates cannot fire regardless of its threshold.",
		evaluate: ({ config, now }) => {
			const statesByRule = new Map<string, AuditAlertRuleState[]>()
			for (const state of config.alertRuleStates) {
				const bucket = statesByRule.get(state.ruleId)
				if (bucket) bucket.push(state)
				else statesByRule.set(state.ruleId, [state])
			}

			const enabledRules = Arr.filter(config.alertRules, (rule) => rule.enabled)
			const stalled = Arr.flatMap(enabledRules, (rule) => {
				const states = statesByRule.get(rule.id) ?? []
				const errored = Option.getOrUndefined(
					Arr.findFirst(states, (state) => state.lastError !== null),
				)
				if (errored?.lastError != null) {
					return [
						{
							kind: "alert_rule" as const,
							id: rule.id,
							name: rule.name,
							note: `evaluation error: ${briefError(errored.lastError)}`,
						},
					]
				}
				if (rule.lastScheduledAt === null) {
					return now - rule.createdAt > RULE_NEVER_SCHEDULED_GRACE_MS
						? [
								{
									kind: "alert_rule" as const,
									id: rule.id,
									name: rule.name,
									note: "never evaluated",
								},
							]
						: []
				}
				// The scheduler claims a rule once per its effective interval (1 to 60 minutes, picked or
				// slowed), so a claim older than two intervals means it fell out of the rotation.
				const age = now - rule.lastScheduledAt
				return age > ruleScheduleStaleMs(rule.evaluationIntervalMinutes)
					? [
							{
								kind: "alert_rule" as const,
								id: rule.id,
								name: rule.name,
								note: `last evaluated ${formatAgo(age)} ago`,
							},
						]
					: []
			})

			return stalled.length === 0
				? PASS
				: fail(
						`${plural(stalled.length, "enabled alert rule")} ${conj(stalled.length, "is", "are")} not evaluating cleanly, so ${conj(stalled.length, "it", "they")} cannot fire.`,
						stalled,
					)
		},
	},
]

const notificationChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-NOTIF-01",
		category: "notifications",
		title: "New errors notify someone",
		severity: "critical",
		fixHint:
			"Ask Maple's AI assistant to send error notifications to one of the enabled destinations listed in Alerts → Routing.",
		evaluate: ({ config }) => {
			// A missing row means Maple's defaults apply: enabled, but with an empty destination list —
			// which still routes nowhere, so the second arm below catches it.
			const policy = config.errorNotificationPolicy ?? { enabled: true, destinationIds: [] }
			if (!policy.enabled) {
				return fail(
					"Error notifications are turned off — new and regressed errors will surface in the dashboard only.",
				)
			}
			const deliverable = new Set(
				Arr.map(
					Arr.filter(config.alertDestinations, (d) => d.enabled),
					(d) => d.id,
				),
			)
			if (Arr.some(policy.destinationIds, (id) => deliverable.has(id))) return PASS
			return fail(
				policy.destinationIds.length === 0
					? "Error notifications are enabled but no destination is selected, so nothing is delivered."
					: "Every destination selected for error notifications is disabled or deleted.",
			)
		},
	},
	{
		id: "CFG-ANOM-01",
		category: "notifications",
		title: "Anomaly detection is enabled",
		severity: "info",
		fixHint:
			"There is no in-app switch yet: an org admin turns it back on through the Maple API's anomaly settings endpoint, which brings back baseline-relative alerts without writing rules.",
		evaluate: ({ config }) =>
			// Only an explicit opt-out counts; a missing row means the zero-config default (enabled).
			config.anomalyDetector !== null && !config.anomalyDetector.enabled
				? fail(
						"Anomaly detection is explicitly disabled — Maple will not flag sudden shifts in latency, throughput or error volume.",
					)
				: PASS,
	},
	{
		id: "CFG-DASH-01",
		category: "notifications",
		title: "At least one dashboard exists",
		severity: "info",
		fixHint:
			"Create one from Dashboards, or ask Maple's AI assistant to build one from your busiest service's operations.",
		evaluate: ({ config }) =>
			config.dashboardCount > 0
				? PASS
				: fail(
						"No dashboards yet. Service views cover a lot, but a dashboard is how you put your own metrics side by side.",
					),
	},
]

const ingestionChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-SAMP-01",
		category: "ingestion",
		title: "Trace sampling is understood",
		severity: "info",
		fixHint:
			"Span counts and throughput are scaled estimates while sampling is on. Nothing to fix if this is intentional.",
		evaluate: ({ config }) => {
			const policy = config.samplingPolicy
			if (policy === null || policy.traceSampleRatio >= 1) return PASS
			const percent = Math.round(policy.traceSampleRatio * 1000) / 10
			const kept = policy.alwaysKeepErrorSpans
				? "Error spans are always kept."
				: "Error spans are sampled at the same rate — errors can be missed entirely."
			return fail(
				`The ingest gateway keeps ${percent}% of traces. Span counts and throughput are extrapolated, not exact. ${kept}`,
			)
		},
	},
	{
		id: "CFG-ATTR-01",
		category: "attributes",
		title: "No open instrumentation recommendations",
		severity: "warn",
		fixHint:
			"Settings → Ingestion → Recommended mappings: apply the renames or dismiss the ones you don't plan to act on.",
		evaluate: ({ config }) =>
			config.openRecommendationCount === 0
				? PASS
				: fail(
						`${plural(config.openRecommendationCount, "open instrumentation recommendation")} — deprecated or non-conforming attribute keys detected in your live spans.`,
					),
	},
	{
		id: "CFG-MAP-01",
		category: "attributes",
		title: "Every attribute mapping still matches live telemetry",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Delete the mapping, or fix its source key — it is dead configuration that will mislead the next reader.",
		evaluate: ({ config, warehouse }) => {
			if (!warehouse) return PASS
			const present = spanKeySet(warehouse)
			const dead = Arr.map(
				Arr.filter(
					config.attributeMappings,
					(mapping) =>
						mapping.enabled &&
						mapping.sourceContext === "span" &&
						!present.has(mapping.sourceKey) &&
						// A working move deletes its source, so the target arriving means it runs.
						!(mapping.operation === "move" && present.has(mapping.targetKey)),
				),
				(mapping) => ({
					kind: "attribute_mapping" as const,
					id: mapping.id,
					name: mapping.name,
					note: `${mapping.sourceKey} no longer arrives`,
				}),
			)
			return dead.length === 0
				? PASS
				: fail(
						`${plural(dead.length, "enabled attribute mapping")} references a key that has not arrived in the last ${warehouse.lookbackHours}h.`,
						dead,
					)
		},
	},
	{
		id: "CFG-MAP-02",
		category: "attributes",
		title: "No attribute mapping is a silent no-op",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Stop emitting the source key at the SDK — the mapping cannot merge two keys, so it will never run.",
		evaluate: ({ config, warehouse, now }) => {
			if (!warehouse) return PASS
			const present = spanKeySet(warehouse)
			const lookbackMs = warehouse.lookbackHours * 60 * 60 * 1000
			// Stored spans are post-mapping, so a working mapping's target is always present. Only a
			// span move is decidable: it deletes its source, so a surviving source means it was skipped
			// because the target already arrived (`apply_attribute_mappings` never overwrites).
			const noop = Arr.map(
				Arr.filter(
					config.attributeMappings,
					(mapping) =>
						mapping.enabled &&
						mapping.sourceContext === "span" &&
						mapping.operation === "move" &&
						// Spans from before the mapping changed still carry the source key.
						now - mapping.updatedAt > lookbackMs &&
						present.has(mapping.sourceKey) &&
						present.has(mapping.targetKey),
				),
				(mapping) => ({
					kind: "attribute_mapping" as const,
					id: mapping.id,
					name: mapping.name,
					note: `${mapping.targetKey} already arrives natively`,
				}),
			)
			return noop.length === 0
				? PASS
				: fail(
						`${plural(noop.length, "enabled attribute mapping")} can never fire — the target key is already present on incoming spans, and mappings never overwrite an existing value.`,
						noop,
					)
		},
	},
]

const platformChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-BYOC-01",
		category: "data_platform",
		title: "Bring-your-own ClickHouse is reachable",
		severity: "critical",
		fixHint:
			"Settings → Data platform: re-test the connection. Credentials, network policy and cluster health are the usual causes.",
		evaluate: ({ config }) => {
			const clickhouse = config.clickhouse
			if (clickhouse === null || clickhouse.syncStatus !== "error") return PASS
			return fail(
				`Your ClickHouse connection is in an error state${clickhouse.lastSyncError ? `: ${briefError(clickhouse.lastSyncError)}` : "."} Queries and ingest both depend on it.`,
			)
		},
	},
	{
		id: "CFG-BYOC-02",
		category: "data_platform",
		title: "Bring-your-own ClickHouse schema is up to date",
		severity: "warn",
		fixHint:
			"Settings → Data platform → Apply schema. Newer Maple features query tables the older schema doesn't have.",
		evaluate: ({ config }) => {
			const clickhouse = config.clickhouse
			if (clickhouse === null) return PASS
			if (clickhouse.schemaVersion === clickhouse.expectedSchemaVersion) return PASS
			// Rows written by older code stored a project revision hash here rather than a migration
			// version. Abbreviate it — a 64-character hash in a finding sentence tells nobody anything.
			const applied = clickhouse.schemaVersion
			const shown =
				applied === null
					? "an unrecognized version"
					: applied.length > 12
						? `an unrecognized version (${Str.slice(0, 8)(applied)}…)`
						: `schema ${applied}`
			return fail(
				`Your cluster reports ${shown}; Maple expects schema ${clickhouse.expectedSchemaVersion}.`,
			)
		},
	},
]

/** A source failing with no success for this long has lost data, not just lagged: critical. */
const DATA_LOSS_HOURS = 24

const losingData = (lastSuccessAt: number | null, now: number): boolean =>
	lastSuccessAt !== null && now - lastSuccessAt > DATA_LOSS_HOURS * 60 * 60_000

/** A connection younger than this is still on its first polls, so "pending" is not a problem yet. */
const INTEGRATION_PENDING_GRACE_MS = 60 * 60_000

const inventoryEntry = (
	inventory: IntegrationInventory | undefined,
	provider: IntegrationEntry["provider"],
): IntegrationEntry | undefined =>
	inventory === undefined
		? undefined
		: Option.getOrUndefined(
				Arr.findFirst(inventory.integrations, (integration) => integration.provider === provider),
			)

/**
 * The provider-wide problem (a pending setup step, a missing permission, a rejected token), or null
 * when the entry's problem only summarizes its resources. A revoked OAuth grant is CFG-INTEG-01's.
 */
const providerProblem = (entry: IntegrationEntry): string | null => {
	if (entry.status === "disconnected" && entry.provider !== "railway") return null
	return entry.problem !== null && entry.problem !== summarizeResources(entry.resources)
		? entry.problem
		: null
}

/** What a resource's status means, in words; `resource.note` is metadata, never the error. */
const resourceNote = (resource: IntegrationResource, now: number): string => {
	switch (resource.status) {
		case "failing":
			return briefError(resource.lastError ?? "last poll failed")
		case "stale":
			return resource.lastSuccessAt === null
				? "no successful update yet"
				: `no successful update for ${formatAgo(now - resource.lastSuccessAt)}`
		case "pending":
			return "never polled successfully yet"
		case "paused":
			return "paused"
		case "disconnected":
			return briefError(resource.lastError ?? "disconnected")
		case "healthy":
			return "healthy"
	}
}

/** One provider's problems from the inventory: its own condition first, then each unhealthy resource. */
const inventoryFindings = (
	inventory: IntegrationInventory | undefined,
	provider: IntegrationEntry["provider"],
	now: number,
	only?: { readonly kinds: ReadonlySet<string>; readonly failingOnly: boolean },
): ReadonlyArray<AuditAffectedEntity> => {
	const entry = inventoryEntry(inventory, provider)
	if (entry === undefined) return []
	const settling = entry.connectedAt !== null && now - entry.connectedAt < INTEGRATION_PENDING_GRACE_MS
	const resources = Arr.map(
		Arr.filter(
			entry.resources,
			(resource) =>
				(only?.failingOnly ? resource.status === "failing" : resource.status !== "healthy") &&
				!(resource.status === "pending" && settling) &&
				(only === undefined || only.kinds.has(resource.kind)),
		),
		(resource) => ({
			kind: "integration" as const,
			name: `${resource.kind} ${resource.name}`,
			note: resourceNote(resource, now),
		}),
	)
	const problem = only === undefined ? providerProblem(entry) : null
	const own =
		problem !== null && !(entry.status === "pending" && settling)
			? [{ kind: "integration" as const, name: provider, note: briefError(problem) }]
			: []
	return [...own, ...resources]
}

/** True when a provider's failing or stale resource has had no success for over a day. */
const inventoryLosingData = (
	inventory: IntegrationInventory | undefined,
	provider: IntegrationEntry["provider"],
	now: number,
	kinds?: ReadonlySet<string>,
): boolean =>
	Arr.some(
		inventoryEntry(inventory, provider)?.resources ?? [],
		(resource) =>
			(resource.status === "failing" || resource.status === "stale") &&
			(kinds === undefined || kinds.has(resource.kind)) &&
			losingData(resource.lastSuccessAt, now),
	)

const dataLossSeverity = (losing: boolean) => (losing ? { severity: "critical" as const } : undefined)

/** The PlanetScale fix that matches what is actually wrong. */
const planetscaleFixHint = (entry: IntegrationEntry | undefined): string => {
	const problem = entry === undefined ? null : providerProblem(entry)
	if (problem === PLANETSCALE_NO_ORGANIZATION_PROBLEM) {
		return "Sources → PlanetScale: pick the PlanetScale organization Maple should monitor."
	}
	if (problem !== null && entry?.status !== "pending") {
		return "Sources → PlanetScale: reconnect PlanetScale and grant every permission it asks for."
	}
	return "Maple retries PlanetScale polls on its own. If a database stays failing or stale, check that the connected PlanetScale account can still read it, then reconnect in Sources."
}

const integrationChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-INTEG-01",
		category: "integrations",
		title: "No integration connection has been revoked",
		severity: "warn",
		fixHint:
			"Reconnect the integration — a revoked grant makes its poller skip silently, with no other surface.",
		evaluate: ({ config }) => {
			const revoked = Arr.map(
				Arr.filter(config.integrations, (integration) => integration.revokedAt !== null),
				(integration) => ({
					kind: "integration" as const,
					name: integration.provider,
					note: "access revoked — reconnect required",
				}),
			)
			return revoked.length === 0
				? PASS
				: fail(
						`${plural(revoked.length, "integration")} lost access. ${conj(revoked.length, "Its", "Their")} data stopped arriving when the grant was revoked.`,
						revoked,
					)
		},
	},
	{
		id: "CFG-INTEG-02",
		category: "integrations",
		title: "Cloudflare analytics collection is succeeding",
		severity: "warn",
		fixHint:
			"A permission error means the token lacks a scope: reconnect Cloudflare in Sources and grant Analytics and Firewall read access. A 5xx from Cloudflare is retried every few minutes; reconnect if it lasts more than a few hours.",
		evaluate: ({ config, now }) => {
			// An error is current only when no success landed after it; older ones were recovered from.
			const failing = Arr.filter(
				config.cloudflareAnalytics,
				(state) => state.lastErrorAt !== null && state.lastErrorAt > (state.lastSuccessAt ?? 0),
			)
			// One poll failure is stamped on every dataset of a connection at once, so group by dataset
			// and message rather than listing each zone.
			const groups = Arr.groupBy(failing, (state) => `${state.dataset}\x00${state.lastError ?? ""}`)
			const losingCount = Arr.filter(failing, (state) => losingData(state.lastSuccessAt, now)).length
			const losing = losingCount > 0
			const affected = Arr.map(Rec.values(groups), (group): AuditAffectedEntity => {
				const first = Arr.headNonEmpty(group)
				const zones = Arr.filter(group, (state) => state.zoneName !== null)
				const name =
					group.length === 1
						? first.zoneName
							? `${first.dataset} · ${first.zoneName}`
							: first.dataset
						: zones.length === group.length
							? `${first.dataset} on ${group.length} zones`
							: `${first.dataset} (${group.length})`
				const lastErrorAt = Arr.reduce(group, 0, (latest, state) =>
					Math.max(latest, state.lastErrorAt ?? 0),
				)
				const lastSuccessAt = Arr.reduce(group, 0, (latest, state) =>
					Math.max(latest, state.lastSuccessAt ?? 0),
				)
				const success =
					lastSuccessAt === 0
						? "never succeeded"
						: `last success ${formatAgo(now - lastSuccessAt)} ago`
				return {
					kind: "integration",
					name,
					note: `${briefError(first.lastError ?? "last poll failed")} (${formatAgo(now - lastErrorAt)} ago), ${success}`,
				}
			})
			if (affected.length === 0) return PASS
			// A grouped row stands for every dataset in it, so the count (and the ranking) is per dataset.
			return {
				...fail(
					`${plural(failing.length, "Cloudflare dataset")} ${conj(failing.length, "has", "have")} failed since ${conj(failing.length, "its", "their")} last successful poll${
						losing
							? `, ${losingCount === failing.length ? "all" : losingCount} for over ${DATA_LOSS_HOURS} hours, so that data is missing`
							: ""
					}.`,
					affected,
				),
				affectedCount: failing.length,
				...(losing ? { severity: "critical" as const } : undefined),
			}
		},
	},
	{
		id: "CFG-INTEG-03",
		category: "integrations",
		title: "Source repositories are syncing",
		severity: "warn",
		fixHint:
			"Re-check the repository's installation in Sources; commit linking and release markers depend on it.",
		evaluate: ({ config }) => {
			const failing = Arr.map(
				Arr.filter(config.vcsRepositories, (repository) => repository.syncStatus === "error"),
				(repository) => ({
					kind: "repository" as const,
					id: repository.id,
					name: repository.fullName,
					note: briefError(repository.lastSyncError ?? "sync failed"),
				}),
			)
			return failing.length === 0
				? PASS
				: fail(
						`${plural(failing.length, "repository", "repositories")} failed to sync — release markers and commit context will be stale.`,
						failing,
					)
		},
	},
	{
		id: "CFG-INTEG-04",
		category: "integrations",
		title: "Railway metrics are being collected",
		severity: "warn",
		fixHint:
			"Sources → Railway: save a new API token if Railway rejected it; a stale environment usually means the token lost access to its project.",
		evaluate: ({ config, now }) => {
			const affected = inventoryFindings(config.integrationInventory, "railway", now)
			return affected.length === 0
				? PASS
				: {
						...fail(
							`Railway collection has ${plural(affected.length, "problem")}: charts for the affected environments stop at the last successful poll.`,
							affected,
						),
						...dataLossSeverity(inventoryLosingData(config.integrationInventory, "railway", now)),
					}
		},
	},
	{
		id: "CFG-INTEG-05",
		category: "integrations",
		title: "PlanetScale is fully set up and polling",
		severity: "warn",
		fixHint:
			"Sources → PlanetScale: finish setup or reconnect, as each problem describes; Maple retries failed polls on its own.",
		evaluate: ({ config, now }) => {
			const affected = inventoryFindings(config.integrationInventory, "planetscale", now)
			if (affected.length === 0) return PASS
			return {
				...fail(
					`PlanetScale has ${plural(affected.length, "problem")}: database metrics, inventory or deploy requests are incomplete.`,
					affected,
				),
				fixHint: planetscaleFixHint(inventoryEntry(config.integrationInventory, "planetscale")),
				...dataLossSeverity(inventoryLosingData(config.integrationInventory, "planetscale", now)),
			}
		},
	},
	{
		id: "CFG-INTEG-06",
		category: "integrations",
		title: "Cloudflare Logpush jobs are delivering",
		severity: "warn",
		fixHint:
			"Check the Logpush job in the Cloudflare dashboard; its destination must be Maple's Logpush endpoint.",
		evaluate: ({ config, now }) => {
			const kinds = new Set(["logpush"])
			const affected = inventoryFindings(config.integrationInventory, "cloudflare", now, {
				kinds,
				failingOnly: true,
			})
			return affected.length === 0
				? PASS
				: {
						...fail(`${plural(affected.length, "Logpush job")} reported an error.`, affected),
						...dataLossSeverity(
							inventoryLosingData(config.integrationInventory, "cloudflare", now, kinds),
						),
					}
		},
	},
	{
		id: "CFG-SCRAPE-01",
		category: "integrations",
		title: "Prometheus scrape targets are reachable",
		severity: "warn",
		fixHint: "Verify the target URL and credentials in Sources → Prometheus.",
		evaluate: ({ config }) => {
			const failing = Arr.map(
				Arr.filter(
					config.scrapeTargets,
					(target) => target.enabled && target.lastScrapeError !== null,
				),
				(target) => ({
					kind: "scrape_target" as const,
					id: target.id,
					name: target.name,
					note: briefError(target.lastScrapeError ?? "scrape failed"),
				}),
			)
			return failing.length === 0
				? PASS
				: fail(
						`${plural(failing.length, "scrape target")} failed ${conj(failing.length, "its", "their")} last scrape.`,
						failing,
					)
		},
	},
]

// Telemetry checks — what you are actually ingesting, and whether it follows the
// conventions Maple's features read.

/** Below this a service's log volume is too small for a correlation rate to mean anything. */
const LOG_CORRELATION_MIN_LOGS = 20
/** Share of a service's logs that must lack a TraceId before correlation is worth reporting. */
const LOG_CORRELATION_FAIL_RATIO = 0.9
/** Below this share of correlated logs the bridge never sees a span; above it, it does. */
const LOG_CORRELATION_NONE_RATIO = 0.01
/** Share of a service's spans that must lack an environment before it is worth reporting. */
const MISSING_ENV_RATIO = 0.5
/** Raw span names per ID-free template at which IDs are in the names. */
const SPAN_NAME_ID_RATIO = 2
/** Below this many distinct names, IDs in a few of them are not worth a finding. */
const SPAN_NAME_ID_MIN_RAW = 100
/** Distinct ID-free span names per service above which operation grouping stops being useful. */
const SPAN_NAME_TEMPLATE_LIMIT = 2_000
/** Distinct values for a single metric label above which series counts explode. */
const METRIC_LABEL_CARDINALITY_LIMIT = 1_000
/** Share of a service's database calls that may lack a namespace before the node loses its identity. */
const DB_NAMESPACE_MISSING_RATIO = 0.5
/** Org-wide log volume above which having no structured log attributes is a real finding. */
const UNSTRUCTURED_LOG_MIN_VOLUME = 1_000
/** Distinct log-scope attribute keys below which logging is effectively unstructured. */
const UNSTRUCTURED_LOG_KEY_LIMIT = 3

/** A hostname or IPv4 address: what the map shows when only `server.address` named the database. */
const HOST_LIKE = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.){2,}[a-z]{2,})$/i

/** A database node with no real name: empty, the Hyperdrive sentinel, or a bare host fallback. */
const namelessDbNamespace = (namespace: string): boolean =>
	namespace === "" || namespace === HYPERDRIVE_DB_NAMESPACE || HOST_LIKE.test(namespace)

const STANDARD_SEVERITIES = new Set(["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL"])

/**
 * Attribute keys people invent instead of the semconv names Maple reads. `deployment.commit_sha`
 * was Maple's own vendor key for the commit and is retired: nothing reads it any more, so it is
 * flagged like any other parallel spelling of `vcs.ref.head.revision`.
 */
const INVENTED_RESOURCE_KEYS = [
	"env",
	"environment",
	"deployment.commit_sha",
	"git.repo",
	"git.commit",
	"git.sha",
	"repo.url",
	"commit.sha",
	"app.repo_url",
	"service.env",
]

/**
 * Words that always name a secret, anywhere in the key (`db.password.hash`, `credit.card.number`),
 * unless the key ends in a metadata word. Values are never scanned, which would read every attribute map.
 */
const STRONG_SENSITIVE_WORDS = new Set([
	"password",
	"passwd",
	"creditcard",
	"cardnumber",
	"privatekey",
	"ssn",
	"cvv",
])
/** A trailing word that makes the key describe a secret: `password_changed`, `password.policy`. */
const METADATA_WORDS = new Set([
	"id",
	"kind",
	"type",
	"scope",
	"count",
	"length",
	"policy",
	"strength",
	"changed",
	"reset",
	"required",
	"enabled",
	"expired",
	"valid",
	"set",
	"present",
	"rejected",
	"cache",
	"hit",
	"used",
	"at",
	"source",
	"status",
])
/** Words that name a secret only as the key's trailing word(s): `oauth.client_secret`, not `token.scope`. */
const WEAK_SENSITIVE_WORDS = new Set([
	"token",
	"secret",
	"credential",
	"credentials",
	"apikey",
	"authorization",
	"pin",
	"accesstoken",
	"refreshtoken",
	"sessiontoken",
	"clientsecret",
	"setcookie",
])
/** Captured headers whose value is a credential even though the name says nothing of the kind. */
const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "proxy-authorization", "x-api-key"])
const HEADER_KEY = /^http\.(?:request|response)\.header\.(.+)$/
/** A leading `has`/`is` makes the key a flag about a secret, not the secret. */
const FLAG_WORDS = new Set(["has", "is"])

/** Span keys PII-01 flags, which the attribution read names an emitter for. */
export const sensitiveSpanKeys = (attributeKeys: ReadonlyArray<AuditAttributeKey>): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(attributeKeys, (row) => row.scope === "span" && looksSensitive(row.key)),
		(row) => row.key,
	)

/** True when an attribute key name looks like it carries a secret. */
export const looksSensitive = (key: string): boolean => {
	const lower = Str.toLowerCase(key)
	const header = HEADER_KEY.exec(lower)?.[1]
	if (header !== undefined && SENSITIVE_HEADERS.has(header)) return true
	const words = Arr.filter(Str.split(/[.\-_/\s]/)(lower), (word) => word !== "")
	if (Arr.some(words, (word) => FLAG_WORDS.has(word))) return false
	const last = words.at(-1) ?? ""
	const lastTwo = `${words.at(-2) ?? ""}${last}`
	if (WEAK_SENSITIVE_WORDS.has(last) || WEAK_SENSITIVE_WORDS.has(lastTwo)) return true
	if (METADATA_WORDS.has(last)) return false
	// Single words and adjacent pairs, so `credit.card` reads as `creditcard`.
	const pairs = Arr.map(Arr.drop(words, 1), (word, index) => `${words[index] ?? ""}${word}`)
	return Arr.some([...words, ...pairs], (word) => STRONG_SENSITIVE_WORDS.has(word))
}

const nameWords = (name: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(/[^a-z0-9]+/)(Str.toLowerCase(name)), (word) => word !== "")

/** Same name up to separators and case, or one extra trailing word (`api` / `api-server`). */
const isNameVariant = (a: string, b: string): boolean => {
	const [x, y] = [nameWords(a), nameWords(b)]
	const [short, long] = x.length <= y.length ? [x, y] : [y, x]
	if (short.length === 0 || long.length - short.length > 1) return false
	return Arr.every(short, (word, index) => long[index] === word)
}

/** `maple_ai.*` is stamped by Maple's own ingest on agent spans (see `gen-ai.ts`), not by the customer. */
const isMapleWrittenKey = (key: string): boolean => Str.startsWith("maple_ai.")(Str.toLowerCase(key))

// Who can fix a service's telemetry
//
// Per-service checks only make sense for services the user instruments. Maple writes some services
// itself (uptime checks, CI traces, pulled integration metrics) and client apps lack server traits by
// design, so each service is classified once and the checks read that classification.

/** `CI_SERVICE_NAME` in `./tinybird/datasources`; imported, it would pull the warehouse schema in here. */
const CI_TRACES_SERVICE_NAME = "github-actions"

/** Service names Maple writes on the user's behalf; the raw log read skips them outright. */
export const MAPLE_GENERATED_SERVICE_NAMES: ReadonlyArray<string> = [
	UPTIME_SERVICE_NAME,
	CI_TRACES_SERVICE_NAME,
]

/** Metric services the Cloudflare analytics integration writes, one per zone, worker or queue. */
export const MAPLE_INTEGRATION_SERVICE_PREFIXES: ReadonlyArray<string> = [
	"cloudflare/",
	"cloudflare-worker/",
	"cloudflare-queue/",
]

/** SDK languages that only ever run on a user's device. */
const CLIENT_SDK_LANGUAGES = new Set(["webjs", "swift"])
const PREVIEW_ENVIRONMENT = /^(?:pr-\d+|preview(?:[-_].*)?)$/i

export type AuditServiceOrigin = "maple" | "client" | "preview" | "app"

/** Classifies one service; an unknown identity (metric-only services) is judged by name. */
export const classifyService = (
	serviceName: string,
	identity: AuditServiceIdentity | undefined,
): AuditServiceOrigin => {
	const namespaces = identity?.namespaces ?? []
	if (
		MAPLE_GENERATED_SERVICE_NAMES.includes(serviceName) ||
		Arr.some(namespaces, (namespace) => isMapleService({ serviceName, serviceNamespace: namespace })) ||
		Arr.some(MAPLE_INTEGRATION_SERVICE_PREFIXES, (prefix) => Str.startsWith(prefix)(serviceName))
	) {
		return "maple"
	}
	if (identity === undefined) return "app"
	const environments = identity.environments
	// A CLI tags itself with a `cli` environment; browsers and mobile apps by SDK language.
	const cliOnly =
		environments.length > 0 && Arr.every(environments, (env) => Str.toLowerCase(env) === "cli")
	if (
		cliOnly ||
		Arr.some(identity.sdkLanguages, (lang) => CLIENT_SDK_LANGUAGES.has(Str.toLowerCase(lang)))
	) {
		return "client"
	}
	return environments.length > 0 && Arr.every(environments, (env) => PREVIEW_ENVIRONMENT.test(env))
		? "preview"
		: "app"
}

const originCache = new WeakMap<WarehouseAuditInputs, (serviceName: string) => AuditServiceOrigin>()

/** Memoized per snapshot: every check asks, the answer never changes within one audit. */
const serviceOrigin = (warehouse: WarehouseAuditInputs): ((serviceName: string) => AuditServiceOrigin) => {
	const cached = originCache.get(warehouse)
	if (cached) return cached
	const identities = new Map(
		Arr.map(warehouse.services, (identity) => [identity.serviceName, identity] as const),
	)
	const origins = new Map<string, AuditServiceOrigin>()
	const lookup = (serviceName: string): AuditServiceOrigin => {
		const known = origins.get(serviceName)
		if (known) return known
		const origin = classifyService(serviceName, identities.get(serviceName))
		origins.set(serviceName, origin)
		return origin
	}
	originCache.set(warehouse, lookup)
	return lookup
}

/**
 * The snapshot with every Maple-written service removed from the per-service inputs, so no check can
 * blame the user for telemetry Maple produces. Org-wide trace totals lose the removed services'
 * traces too.
 */
export const withoutMapleServices = (warehouse: WarehouseAuditInputs): WarehouseAuditInputs => {
	const origin = serviceOrigin(warehouse)
	const isUsers = (serviceName: string) => origin(serviceName) !== "maple"
	const byUsers = <A extends { readonly serviceName: string }>(rows: ReadonlyArray<A> | undefined) =>
		rows === undefined ? undefined : Arr.filter(rows, (row) => isUsers(row.serviceName))
	const metricLabelSeries = byUsers(warehouse.metricLabelSeries)
	const spanNameTemplates = byUsers(warehouse.spanNameTemplates)
	const serviceResourceKeys = byUsers(warehouse.serviceResourceKeys)
	const traces = warehouse.traceCompleteness
	const mapleRootless = Arr.filter(traces?.rootless ?? [], (row) => !isUsers(row.entryService))
	const minus = (pick: (row: (typeof mapleRootless)[number]) => number) =>
		Arr.reduce(mapleRootless, 0, (sum, row) => sum + pick(row))
	const scoped: WarehouseAuditInputs = {
		...warehouse,
		serviceUsage: Arr.filter(warehouse.serviceUsage, (row) => isUsers(row.serviceName)),
		spanShape: Arr.filter(warehouse.spanShape, (row) => isUsers(row.serviceName)),
		logSeverity: Arr.filter(warehouse.logSeverity, (row) => isUsers(row.serviceName)),
		dbEdges: Arr.filter(warehouse.dbEdges, (row) => isUsers(row.serviceName)),
		logCorrelation: Arr.filter(warehouse.logCorrelation, (row) => isUsers(row.serviceName)),
		resourceKeyServices: Arr.filter(warehouse.resourceKeyServices, (row) => isUsers(row.serviceName)),
		...(metricLabelSeries === undefined ? undefined : { metricLabelSeries }),
		...(spanNameTemplates === undefined ? undefined : { spanNameTemplates }),
		...(serviceResourceKeys === undefined ? undefined : { serviceResourceKeys }),
		traceCompleteness:
			traces === undefined
				? undefined
				: {
						...traces,
						orphans: Arr.filter(traces.orphans, (row) => isUsers(row.serviceName)),
						inboundRoutes: Arr.filter(traces.inboundRoutes, (row) => isUsers(row.serviceName)),
						rootless: Arr.map(
							Arr.filter(traces.rootless, (row) => isUsers(row.entryService)),
							(row) => ({
								...row,
								orgTraceCount: row.orgTraceCount - minus((r) => r.traceCount),
								orgRootlessCount: row.orgRootlessCount - minus((r) => r.rootlessCount),
								orgSampledRootlessCount:
									row.orgSampledRootlessCount - minus((r) => r.sampledRootlessCount),
								orgExternalParentCount:
									row.orgExternalParentCount - minus((r) => r.externalParentCount),
							}),
						),
					},
	}
	// The scoped snapshot classifies exactly like the original.
	originCache.set(scoped, origin)
	return scoped
}

/** The invented resource keys present in an attribute inventory, which RES-06 reports. */
export const inventedResourceKeys = (
	attributeKeys: ReadonlyArray<AuditAttributeKey>,
): ReadonlyArray<string> => {
	const present = new Set(
		Arr.map(
			Arr.filter(attributeKeys, (row) => row.scope === "resource"),
			(row) => row.key,
		),
	)
	return Arr.filter(INVENTED_RESOURCE_KEYS, (key) => present.has(key))
}

/** Metric labels past the cardinality limit, which MET-01 reports. */
export const explodedMetricLabels = (labels: WarehouseAuditInputs["metricLabels"]): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(labels, (label) => label.valueCardinality > METRIC_LABEL_CARDINALITY_LIMIT),
		(label) => label.attributeKey,
	)

/** Max characters of a log message or attribute value quoted into a finding, ellipsis included. */
const QUOTE_LIMIT = 80
/** A whole 24+ character run of token characters holding both a digit and a letter. */
const OPAQUE_RUN =
	/(?<![A-Za-z0-9+/_=.-])(?=[A-Za-z0-9+/_=.-]*\d)(?=[A-Za-z0-9+/_=.-]*[A-Za-z])[A-Za-z0-9+/_=.-]{24,}/g
/**
 * `<key>=<value>` where the key ends in a secret word, also as an identifier suffix (`refresh_token`,
 * `client_secret`). Plural `tokens` is a count (`output_tokens=40`), so only singular `token` counts.
 */
const SECRET_ASSIGNMENT =
	/(?<![A-Za-z0-9])([A-Za-z0-9_-]*?(?:passwords?|passwd|pwd|secrets?|token|api[_-]?keys?|credentials?))(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi
/** An authorization header value, scheme and credential both (`Basic dXNlcjpw`). */
const AUTHORIZATION = /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:[A-Za-z]+\s+)?[^\s"',;&]+/gi
const BEARER = /\bbearer\s+[^\s"',;&]+/gi
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g

/**
 * A log line or attribute value made safe to quote: credentials and long opaque runs (keys, JWTs,
 * hashes) are masked, then the result is capped. Long runs of plain words are kept.
 */
export const quoteSafely = (raw: string): string => {
	const masked = pipe(
		Str.trim(raw),
		Str.replace(URL_CREDENTIALS, "//[redacted]@"),
		Str.replace(AUTHORIZATION, "$1$2[redacted]"),
		Str.replace(BEARER, "Bearer [redacted]"),
		Str.replace(SECRET_ASSIGNMENT, "$1$2[redacted]"),
		Str.replace(OPAQUE_RUN, "[redacted]"),
		Str.replace(/\s+/g, " "),
	)
	return masked.length > QUOTE_LIMIT ? `${Str.slice(0, QUOTE_LIMIT - 1)(masked)}…` : masked
}

/** The semconv key each invented one stands in for. */
const INVENTED_KEY_TARGETS = new Map<string, string>([
	["env", "deployment.environment.name"],
	["environment", "deployment.environment.name"],
	["service.env", "deployment.environment.name"],
	["deployment.commit_sha", "vcs.ref.head.revision"],
	["git.commit", "vcs.ref.head.revision"],
	["git.sha", "vcs.ref.head.revision"],
	["commit.sha", "vcs.ref.head.revision"],
	["git.repo", "vcs.repository.url.full"],
	["repo.url", "vcs.repository.url.full"],
	["app.repo_url", "vcs.repository.url.full"],
])
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i
const VERSION = /^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/

/** Where an invented key belongs, judged by what it holds: a "commit" key carrying `1.2.0+85` is a version. */
const inventedKeyTarget = (key: string, sample: string | undefined): string => {
	const target = INVENTED_KEY_TARGETS.get(key) ?? "its semantic-convention key"
	if (target !== "vcs.ref.head.revision" || sample === undefined || COMMIT_SHA.test(sample)) return target
	return VERSION.test(sample) ? "service.version" : target
}

/**
 * The `[invented, semconv]` pairs whose values the attribution read compares per service, so RES-06
 * can say "remove the duplicate" rather than "rename". A commit key is also compared to the version.
 */
export const inventedKeyTwins = (keys: ReadonlyArray<string>): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(keys, (key) => {
		const target = INVENTED_KEY_TARGETS.get(key)
		if (target === undefined) return []
		return target === "vcs.ref.head.revision"
			? [[key, target] as const, [key, "service.version"] as const]
			: [[key, target] as const]
	})

const serviceList = (services: ReadonlyArray<string>): string =>
	`${Arr.join(Arr.take(services, 3), ", ")}${services.length > 3 ? ` and ${services.length - 3} more` : ""}`

const inventedKeyNote = (
	key: string,
	services: ReadonlyArray<string>,
	duplicates: ReadonlyArray<{ readonly serviceName: string; readonly duplicateOf: string }>,
	sample: string | undefined,
): string => {
	const quoted = sample === undefined ? "" : quoteSafely(sample)
	const value = quoted === "" ? "" : `e.g. "${quoted}"; `
	const renamers = Arr.filter(
		services,
		(service) => !Arr.some(duplicates, (row) => row.serviceName === service),
	)
	const [duplicate] = duplicates
	// Every emitter already sends the semconv key with the same value: the key is pure duplication.
	if (duplicate !== undefined && renamers.length === 0) {
		return `from ${serviceList(Arr.map(duplicates, (row) => row.serviceName))}; ${value}same value as its \`${duplicate.duplicateOf}\`, so remove this key`
	}
	const from = renamers.length === 0 ? "" : `from ${serviceList(renamers)}; `
	const target = inventedKeyTarget(key, sample)
	const looksLikeVersion = target === "service.version" && INVENTED_KEY_TARGETS.get(key) !== target
	const removeToo =
		duplicate === undefined
			? ""
			: `; remove it on ${serviceList(Arr.map(duplicates, (row) => row.serviceName))}, which already ${conj(duplicates.length, "sends", "send")} \`${duplicate.duplicateOf}\``
	return `${from}${value}${looksLikeVersion ? "holds a version, so send it as" : "rename to"} \`${target}\`${removeToo}`
}

/**
 * LOG-02's split of traced services whose logs mostly lack trace context: `bridgeless` never
 * correlate, `outside` correlate sometimes (the bridge works, those lines sit outside any span).
 */
export const classifyLogCorrelation = (
	warehouse: Pick<WarehouseAuditInputs, "serviceUsage" | "logCorrelation">,
): {
	readonly bridgeless: ReadonlyArray<AuditLogCorrelation>
	readonly outside: ReadonlyArray<AuditLogCorrelation>
} => {
	const traced = new Set(
		Arr.map(
			Arr.filter(warehouse.serviceUsage, (s) => s.traceCount > 0),
			(s) => s.serviceName,
		),
	)
	const eligible = Arr.filter(
		warehouse.logCorrelation,
		(row) =>
			traced.has(row.serviceName) &&
			row.logCount >= LOG_CORRELATION_MIN_LOGS &&
			row.uncorrelatedCount / row.logCount > LOG_CORRELATION_FAIL_RATIO,
	)
	const neverCorrelated = (row: AuditLogCorrelation) =>
		(row.logCount - row.uncorrelatedCount) / row.logCount < LOG_CORRELATION_NONE_RATIO
	return {
		bridgeless: Arr.filter(eligible, neverCorrelated),
		outside: Arr.filter(eligible, (row) => !neverCorrelated(row)),
	}
}

const ingestCoverageChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "RES-01",
		category: "ingestion",
		title: "Every service sets service.name",
		severity: "critical",
		needsWarehouse: true,
		fixHint:
			"Set `service.name` explicitly on the OTel resource in each service's bootstrap — the SDK default is not a usable identity.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Both failure modes of an unset resource: the SDK's synthetic default, and an empty
			// string where the attribute was omitted entirely.
			const unknown = Arr.map(
				Arr.filter(
					warehouse.serviceUsage,
					(service) =>
						service.serviceName === "" || Str.startsWith("unknown_service")(service.serviceName),
				),
				(service) => ({
					kind: "service" as const,
					name: service.serviceName === "" ? "(no service.name)" : service.serviceName,
					note: `${service.traceCount} traces, ${service.logCount} logs`,
				}),
			)
			return unknown.length === 0
				? PASS
				: fail(
						"Telemetry is arriving with no usable `service.name` — either the SDK's synthetic `unknown_service` default or an empty value. It is invisible to the services list, the service map and any alert scoped by service.",
						unknown,
					)
		},
	},
	{
		id: "ING-01",
		category: "ingestion",
		title: "Service names agree across signals",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Share one resource (and therefore one `service.name`) between the tracer and the logger in each service.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Logs-only, deliberately NOT metrics-only: scraped exporters, cloud-platform collectors
			// and synthetic checks all legitimately ship metrics under a name that never traces. A
			// logs-only name is only a split when a traced service carries nearly the same name;
			// otherwise it is a service that logs without a tracer, which is not this check's finding.
			// Unnamed services are RES-01's finding, not a mismatch.
			const traced = Arr.filter(
				warehouse.serviceUsage,
				(service) => service.traceCount > 0 && service.serviceName !== "",
			)
			const split = Arr.flatMap(
				Arr.filter(
					warehouse.serviceUsage,
					(service) =>
						service.traceCount === 0 && service.logCount > 0 && service.serviceName !== "",
				),
				(service: AuditServiceUsage): Array<AuditAffectedEntity> => {
					const twin = Arr.findFirst(traced, (candidate) =>
						isNameVariant(service.serviceName, candidate.serviceName),
					)
					return Option.isNone(twin)
						? []
						: [
								{
									kind: "service" as const,
									name: service.serviceName,
									note: `logs only; traces arrive as "${twin.value.serviceName}"`,
								},
							]
				},
			)
			return split.length === 0
				? PASS
				: fail(
						`${plural(split.length, "service")} ${conj(split.length, "sends", "send")} logs under a different \`service.name\` than ${conj(split.length, "its", "their")} traces, so one service shows up as two and jumping between its traces and logs finds nothing.`,
						split,
					)
		},
	},
	{
		id: "LOG-01",
		category: "ingestion",
		title: "Traced services also ship logs",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"The service's logger is not exporting to Maple: attach an OTLP log exporter or bridge to the logger it already uses (on Cloudflare Workers, enable the OTLP logs exporter in your telemetry layer next to the trace exporter). Stdout-only logging never reaches Maple.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Gated on the org logging at all: a traces-only setup is a legitimate choice, an
			// inconsistent one is the finding.
			if (!Arr.some(warehouse.serviceUsage, (service) => service.logCount > 0)) return PASS
			// Browsers, mobile apps and CLIs rarely ship logs by design; preview deploys come and go.
			const origin = serviceOrigin(warehouse)
			const silent = Arr.map(
				Arr.filter(
					warehouse.serviceUsage,
					(service) =>
						service.traceCount > 0 &&
						service.logCount === 0 &&
						origin(service.serviceName) === "app",
				),
				(service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: "traces only",
				}),
			)
			return silent.length === 0
				? PASS
				: fail(
						`${plural(silent.length, "service")} ${conj(silent.length, "sends", "send")} traces but no logs, while the rest of the org logs normally. Jumping from a trace to its logs will dead-end there.`,
						silent,
					)
		},
	},
	{
		id: "LOG-02",
		category: "ingestion",
		title: "Logs carry trace context",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"The log bridge is not on the path the app logs through. Attach it to the logger the code actually calls, inside the active span's context.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const { bridgeless, outside } = classifyLogCorrelation(warehouse)
			const bridgelessEntities = Arr.map(bridgeless, (row) => ({
				kind: "service" as const,
				name: row.serviceName,
				note: `${percent(row.uncorrelatedCount, row.logCount)} of logs have no trace_id${
					row.uncorrelatedErrorCount > 0
						? `, including ${row.uncorrelatedErrorCount} error-level`
						: ""
				}`,
			}))
			const outsideEntities = Arr.map(outside, (row) => {
				const message = quoteSafely(row.topUncorrelatedMessage ?? "")
				return {
					kind: "service" as const,
					name: row.serviceName,
					note: `${percent(row.uncorrelatedCount, row.logCount)} of logs are emitted outside any span${
						message === "" ? "" : `, mostly: "${message}"`
					}`,
				}
			})
			if (bridgeless.length > 0) {
				return fail(
					`${plural(bridgeless.length, "service")} ${conj(bridgeless.length, "emits", "emit")} logs with no trace context despite being traced (last ${warehouse.logCorrelationHours}h). Trace↔log correlation is unavailable for them.`,
					[...bridgelessEntities, ...outsideEntities],
				)
			}
			if (outside.length === 0) return PASS
			return {
				...fail(
					`${plural(outside.length, "service")} ${conj(outside.length, "logs", "log")} mostly outside any span (last ${warehouse.logCorrelationHours}h). The bridge works, since some logs carry trace context, but those lines cannot be reached from a trace.`,
					outsideEntities,
				),
				severity: "info",
				fixHint:
					"Usually startup, config or background-loop logs written before any span starts. Emit them inside a span if you want them on a trace; a one-off startup line is fine to leave.",
			}
		},
	},
	{
		id: "LOG-03",
		category: "ingestion",
		title: "Logs are structured",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Pass fields as log attributes (`order_id`, `user_id`) instead of interpolating them into the message string.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const totalLogs = Arr.reduce(warehouse.serviceUsage, 0, (sum, service) => sum + service.logCount)
			if (totalLogs < UNSTRUCTURED_LOG_MIN_VOLUME) return PASS
			const logKeys = keysForScope(warehouse, "log").size
			return logKeys >= UNSTRUCTURED_LOG_KEY_LIMIT
				? PASS
				: fail(
						`${totalLogs.toLocaleString("en-US")} log records arrived carrying ${plural(logKeys, "distinct attribute key")}. Attribute chips, filtering and pattern mining all read those keys.`,
					)
		},
	},
	{
		id: "LOG-04",
		category: "ingestion",
		title: "Log severities use the standard levels",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Map your logger's levels onto TRACE/DEBUG/INFO/WARN/ERROR/FATAL in the OTLP bridge, or at least set a SeverityNumber. Severity drives row coloring and the error banner.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// A text that always arrives with a valid SeverityNumber carries its level there, and is usually
			// the platform's choice (`log` from Workers console.log), with nothing for the user to remap.
			const numbered = new Set(
				Arr.flatMap(warehouse.logCorrelation, (row) => {
					const without = new Set(row.unnumberedOddSeverities ?? [])
					return Arr.map(
						Arr.filter(row.numberedOddSeverities ?? [], (text) => !without.has(text)),
						(text) => `${row.serviceName}\x00${text}`,
					)
				}),
			)
			const offenders = Arr.map(
				Arr.filter(warehouse.logSeverity, (row) => {
					const text = Str.toUpperCase(Str.trim(row.severityText))
					if (text === "" || numbered.has(`${row.serviceName}\x00${row.severityText}`)) return false
					// OTel allows a numeric suffix within a level, e.g. `DEBUG3`.
					return !STANDARD_SEVERITIES.has(Str.replace(/\d+$/, "")(text))
				}),
				(row) => ({
					kind: "service" as const,
					name: row.serviceName,
					note: `severity "${row.severityText}" (${row.logCount} records)`,
				}),
			)
			return offenders.length === 0
				? PASS
				: fail(
						`${plural(offenders.length, "non-standard severity value")} in use. Maple colors rows and raises the error banner from the standard levels only.`,
						offenders,
					)
		},
	},
]

/** Source linking and per-deploy revisions serve server code; a browser or app build reports its version (RES-02) instead. */
const SERVER_SERVICES: ReadonlySet<AuditServiceOrigin> = new Set(["app"])

const attributeQualityChecks: ReadonlyArray<AuditCheck> = [
	resourceKeyCheck(
		"RES-02",
		"Services report their version",
		["service.version"],
		{
			org: "No `service.version` on any resource. Per-version slices on service overview are empty, so a regression cannot be tied to a release.",
			services: (count) =>
				`${plural(count, "service")} ${conj(count, "reports", "report")} no \`service.version\`, so per-version slices are empty for ${conj(count, "it", "them")} and a regression cannot be tied to a release.`,
		},
		"Set `service.version` on the OTel resource from your build's release or short commit SHA.",
	),
	resourceKeyCheck(
		"RES-04",
		"Telemetry links back to source",
		["vcs.repository.url.full"],
		{
			org: "No `vcs.repository.url.full` on any resource, so Maple cannot link a service back to its repository for source context in error debugging.",
			services: (count) =>
				`${plural(count, "service")} ${conj(count, "sets", "set")} no \`vcs.repository.url.full\`, so Maple cannot link ${conj(count, "it", "them")} back to a repository for source context in error debugging.`,
		},
		"Set `vcs.repository.url.full` to the canonical https repo URL — not an SSH remote, not a local path.",
		SERVER_SERVICES,
	),
	resourceKeyCheck(
		"RES-05",
		"Deploys are identifiable",
		["vcs.ref.head.revision"],
		{
			org: "No commit revision on any resource. Release markers and per-deploy comparisons have nothing to anchor to.",
			services: (count) =>
				`${plural(count, "service")} ${conj(count, "sets", "set")} no commit revision, so release markers and per-deploy comparisons have nothing to anchor to for ${conj(count, "it", "them")}.`,
		},
		"Set `vcs.ref.head.revision` best-effort from the build environment (`VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, …). Never shell out to git at runtime.",
		SERVER_SERVICES,
	),
	{
		id: "RES-06",
		category: "attributes",
		title: "No invented resource keys alongside the semconv ones",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Rename each key to the semantic-convention key named on it. Invented keys are stored faithfully but no Maple feature reads them.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const invented = Arr.map(inventedResourceKeys(warehouse.attributeKeys), (key) => {
				const emitters = Arr.filter(warehouse.resourceKeyServices, (row) => row.key === key)
				const services = Arr.dedupe(Arr.map(emitters, (row) => row.serviceName))
				const duplicates = Arr.filterMap(emitters, (row) =>
					row.duplicateOf === undefined
						? Result.failVoid
						: Result.succeed({ serviceName: row.serviceName, duplicateOf: row.duplicateOf }),
				)
				// Samples arrive busiest first.
				const sample = Option.getOrUndefined(
					Arr.findFirst(warehouse.resourceKeySamples, (row) => row.key === key),
				)?.value
				return {
					kind: "attribute_key" as const,
					name: key,
					note: inventedKeyNote(key, services, duplicates, sample),
					duplicated: duplicates.length > 0,
				}
			})
			if (invented.length === 0) return PASS
			const anyDuplicate = Arr.some(invented, (row) => row.duplicated)
			return {
				...fail(
					`${plural(invented.length, "resource attribute")} ${conj(invented.length, "duplicates", "duplicate")} a semantic-convention key under a name nothing reads. The data arrives, but environment filtering, release tracking and source linking stay empty.`,
					Arr.map(invented, ({ duplicated: _duplicated, ...entity }) => entity),
				),
				...(anyDuplicate
					? {
							fixHint:
								"Remove a key that only repeats a semantic-convention key the service already sends with the same value; rename the rest to the key named on each.",
						}
					: undefined),
			}
		},
	},
	{
		id: "RES-03",
		category: "attributes",
		title: "Spans carry a deployment environment",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Set `deployment.environment.name` (Maple also accepts the legacy `deployment.environment`) on the resource in each service's bootstrap.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const missing = Arr.map(
				Arr.filter(
					warehouse.spanShape,
					(service) =>
						service.spanCount > 0 && service.noEnvCount / service.spanCount > MISSING_ENV_RATIO,
				),
				(service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: `${percent(service.noEnvCount, service.spanCount)} of spans have no environment`,
				}),
			)
			return missing.length === 0
				? PASS
				: fail(
						`${plural(missing.length, "service")} ${conj(missing.length, "sends", "send")} most of ${conj(missing.length, "its", "their")} spans with no deployment environment, so environment filtering silently drops them.`,
						missing,
					)
		},
	},
	{
		id: "NAME-02",
		category: "attributes",
		title: "Span names are low-cardinality",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Use `domain.verb` span names (`order.process`) and move IDs and URLs into attributes — never into the name.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const fmt = (count: number) => count.toLocaleString("en-US")
			const templates = warehouse.spanNameTemplates
			// Without the template read only the raw count is known; judge it against the template limit.
			const exploded =
				templates === undefined
					? Arr.map(
							Arr.filter(
								warehouse.spanShape,
								(service) => service.spanNameCount > SPAN_NAME_TEMPLATE_LIMIT,
							),
							(service) => ({
								kind: "service" as const,
								name: service.serviceName,
								note: `${fmt(service.spanNameCount)} distinct span names`,
							}),
						)
					: Arr.filterMap(templates, (service) => {
							const idsInNames =
								service.rawNameCount > SPAN_NAME_ID_MIN_RAW &&
								service.rawNameCount >= SPAN_NAME_ID_RATIO * service.templateCount
							if (!idsInNames && service.templateCount <= SPAN_NAME_TEMPLATE_LIMIT) {
								return Result.failVoid
							}
							const examples =
								idsInNames && service.topTemplateNameCount > 1
									? `; e.g. ${Arr.join(
											Arr.map(service.exampleNames, (name) => `"${quoteSafely(name)}"`),
											", ",
										)}`
									: ""
							return Result.succeed({
								kind: "service" as const,
								name: service.serviceName,
								note: idsInNames
									? `${fmt(service.rawNameCount)} distinct span names but only ${fmt(service.templateCount)} once IDs are removed${examples}`
									: `${fmt(service.templateCount)} distinct span names even with IDs removed`,
							})
						})
			return exploded.length === 0
				? PASS
				: fail(
						`${plural(exploded.length, "service")} ${conj(exploded.length, "emits", "emit")} span names that carry IDs or URLs, or more distinct operations than grouping can use. Operation grouping and top-operations become unusable.`,
						exploded,
					)
		},
	},
	{
		id: "NAME-03",
		category: "attributes",
		title: "The maple_* namespace is left alone",
		severity: "warn",
		needsWarehouse: true,
		fixHint: "Rename these to your own namespace — `maple_*` is reserved and hidden from the UI.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const reserved = Arr.map(
				Arr.filter(
					warehouse.attributeKeys,
					(row) =>
						row.scope !== "resource" &&
						Str.startsWith("maple_")(Str.toLowerCase(row.key)) &&
						!isMapleWrittenKey(row.key),
				),
				(row) => ({ kind: "attribute_key" as const, name: row.key, note: row.scope }),
			)
			return reserved.length === 0
				? PASS
				: fail(
						`${plural(reserved.length, "attribute")} ${conj(reserved.length, "uses", "use")} the reserved \`maple_*\` namespace and ${conj(reserved.length, "is", "are")} hidden from the UI — the data is stored but you cannot see it.`,
						reserved,
					)
		},
	},
	{
		id: "PII-01",
		category: "attributes",
		title: "No secrets in attribute names",
		severity: "critical",
		needsWarehouse: true,
		fixHint:
			"Stop emitting the key at its source and rotate any credential already sent: telemetry is retained and visible across the workspace. Meanwhile an ingest rule that removes the key strips it from new data.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const emitters = warehouse.sensitiveKeyEmitters ?? []
			const sensitive = Arr.map(
				Arr.filter(warehouse.attributeKeys, (row) => looksSensitive(row.key)),
				(row) => {
					const sources = Arr.filter(emitters, (emitter) => emitter.key === row.key)
					const services = Arr.dedupe(Arr.map(sources, (emitter) => emitter.serviceName))
					const spans = Arr.dedupe(
						Arr.map(Arr.take(sources, 2), (emitter) => `"${quoteSafely(emitter.spanName)}"`),
					)
					return {
						kind: "attribute_key" as const,
						name: row.key,
						note: Arr.isReadonlyArrayNonEmpty(services)
							? `${row.scope}; sent by ${serviceList(services)} on ${Arr.join(spans, ", ")}`
							: row.scope,
					}
				},
			)
			return sensitive.length === 0
				? PASS
				: fail(
						`${plural(sensitive.length, "attribute key")} ${conj(sensitive.length, "is", "are")} named as though ${conj(sensitive.length, "it carries", "they carry")} a credential. Only the key names were inspected — check the values before assuming this is a false positive.`,
						sensitive,
					)
		},
	},
	{
		id: "MET-01",
		category: "attributes",
		title: "Metric labels are low-cardinality",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Drop unbounded IDs (user, order, request, raw URL) from metric labels — put them on spans instead, where cardinality is free.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const fmt = (count: number) => count.toLocaleString("en-US")
			const series = warehouse.metricLabelSeries
			const measured = new Set(warehouse.metricLabelsMeasured ?? [])
			// The rollup counts a label's values across every metric; the per-metric read confirms it.
			// A flagged label that read never saw (past its key cap, or it failed) stays on the rollup.
			const fromRollup = Arr.map(
				Arr.filter(
					warehouse.metricLabels,
					(label) =>
						label.valueCardinality > METRIC_LABEL_CARDINALITY_LIMIT &&
						(series === undefined || !measured.has(label.attributeKey)),
				),
				(label) => ({
					kind: "attribute_key" as const,
					name: label.attributeKey,
					note: `~${fmt(label.valueCardinality)} distinct values across all metrics${
						series === undefined ? "" : " (org-wide, not confirmed per metric)"
					}`,
				}),
			)
			const confirmed =
				series === undefined
					? []
					: Arr.map(
							Rec.toEntries(
								Arr.groupBy(
									Arr.filter(
										series,
										(row) => row.valueCardinality > METRIC_LABEL_CARDINALITY_LIMIT,
									),
									(row) => row.attributeKey,
								),
							),
							([attributeKey, rows]) => {
								const busiest = Arr.sort(
									rows,
									Order.mapInput(
										Order.flip(Order.Number),
										(row: AuditMetricLabelSeries) => row.valueCardinality,
									),
								)
								return {
									kind: "attribute_key" as const,
									name: attributeKey,
									note: `${Arr.join(
										Arr.map(
											Arr.take(busiest, 3),
											(row) =>
												`~${fmt(row.valueCardinality)} values on \`${row.metricName}\` (${row.serviceName})`,
										),
										", ",
									)}${busiest.length > 3 ? ` and ${busiest.length - 3} more metrics` : ""}`,
								}
							},
						)
			const exploded = [...confirmed, ...fromRollup]
			return exploded.length === 0
				? PASS
				: fail(
						`${plural(exploded.length, "metric label")} ${conj(exploded.length, "has", "have")} very high cardinality, which multiplies stored series and slows every metrics query. Counter metrics only — gauges and histograms are not covered by this check.`,
						exploded,
					)
		},
	},
]

/** Why a database node lacks its name, in the order MAP-02 lists them. */
type DbIdentityCause = "hyperdrive" | "missing" | "split"
const DB_IDENTITY_CAUSES: ReadonlyArray<DbIdentityCause> = ["hyperdrive", "missing", "split"]

/** Databases reached over an HTTP API, where the host names the deployment (Tinybird's region). */
const HTTP_API_DB_SYSTEMS: ReadonlySet<string> = new Set(["tinybird", "bigquery", "dynamodb"])

const MAP_02_GENERIC_HINT =
	"Set `db.namespace` to the logical database name on database client spans. Without it the map falls back to `db.name`, then to `server.address` (a hostname)."

const serviceMapChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "STAT-01",
		category: "traces",
		title: "Span status and kind use the values Maple stores",
		severity: "critical",
		needsWarehouse: true,
		fixHint:
			"Set status through the SDK's status API rather than hand-stamping a string — error analytics match `Error` exactly, so wrong casing yields zero errors.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const offenders = Arr.map(
				Arr.filter(
					warehouse.spanShape,
					(service) => service.badStatusCodes.length > 0 || service.badSpanKinds.length > 0,
				),
				(service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: Arr.join(
						[
							...Arr.map(service.badStatusCodes, (value) => `status "${value}"`),
							...Arr.map(service.badSpanKinds, (value) => `kind "${value}"`),
						],
						", ",
					),
				}),
			)
			return offenders.length === 0
				? PASS
				: fail(
						`${plural(offenders.length, "service")} ${conj(offenders.length, "emits", "emit")} span status or kind values Maple does not recognize. Those spans are invisible to error rate, the service map and every alert that filters on them.`,
						offenders,
					)
		},
	},
	{
		id: "STAT-02",
		category: "traces",
		title: "Failures are recorded on the span, not just logged",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"On failure paths set Error status and record the exception before rethrowing — a span that swallows the error stays `Unset` and hides it.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const errorLogsByService = new Map<string, number>()
			for (const row of warehouse.logSeverity) {
				const text = Str.replace(/\d+$/, "")(Str.toUpperCase(Str.trim(row.severityText)))
				if (text !== "ERROR" && text !== "FATAL") continue
				errorLogsByService.set(
					row.serviceName,
					(errorLogsByService.get(row.serviceName) ?? 0) + row.logCount,
				)
			}
			const swallowed = Arr.map(
				Arr.filter(
					warehouse.spanShape,
					(service) =>
						service.spanCount > 0 &&
						service.errorCount === 0 &&
						(errorLogsByService.get(service.serviceName) ?? 0) > 0,
				),
				(service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: `${errorLogsByService.get(service.serviceName)} error logs, no error spans`,
				}),
			)
			return swallowed.length === 0
				? PASS
				: fail(
						`${plural(swallowed.length, "service")} ${conj(swallowed.length, "logs", "log")} errors but never ${conj(swallowed.length, "marks", "mark")} a span as failed, so ${conj(swallowed.length, "its", "their")} error rate reads as zero and ${conj(swallowed.length, "its", "their")} failures never open an issue.`,
						swallowed,
					)
		},
	},
	{
		id: "STAT-04",
		category: "traces",
		title: "Inbound work produces Server or Consumer spans",
		severity: "info",
		needsWarehouse: true,
		fixHint:
			"Expected for cron jobs and workers with no inbound traffic. If the service handles requests or queue messages, register the HTTP-server or queue-consumer instrumentation, or give the span that receives the work kind Server (requests) or Consumer (queue messages).",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Browsers, mobile apps and CLIs start traces on the device; they have no inbound work.
			const origin = serviceOrigin(warehouse)
			const noEntry = Arr.map(
				Arr.filter(
					warehouse.spanShape,
					(service) =>
						service.spanCount > 0 &&
						service.serverCount === 0 &&
						service.consumerCount === 0 &&
						origin(service.serviceName) !== "client",
				),
				(service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note:
						service.rootSpanName === undefined
							? "no Server or Consumer spans"
							: `traces start at "${quoteSafely(service.rootSpanName)}" (${service.rootSpanKind ?? "Internal"}), not a Server or Consumer span`,
				}),
			)
			return noEntry.length === 0
				? PASS
				: fail(
						`${plural(noEntry.length, "service")} ${conj(noEntry.length, "emits", "emit")} no entry-point spans. If they serve requests or consume a queue, that instrumentation is not registered or the receiving span has the wrong kind, and route views, throughput attribution and Apdex stay empty for them.`,
						noEntry,
					)
		},
	},
	{
		id: "MAP-02",
		category: "traces",
		title: "Database calls identify their database",
		severity: "warn",
		needsWarehouse: true,
		fixHint: MAP_02_GENERIC_HINT,
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const fmt = (count: number) => count.toLocaleString("en-US")
			const dependencies = Rec.values(
				Arr.groupBy(warehouse.dbEdges, (edge) => `${edge.serviceName}\x00${edge.dbSystem}`),
			)
			const findings = Arr.filterMap(dependencies, (edges) => {
				const first = Arr.headNonEmpty(edges)
				const system = first.dbSystem
				// An HTTP-API warehouse's host (its region) is its identity, so a host node is correct.
				const nameless = (edge: (typeof edges)[number]) =>
					namelessDbNamespace(edge.dbNamespace) &&
					!(HTTP_API_DB_SYSTEMS.has(system) && HOST_LIKE.test(edge.dbNamespace))
				const total = Arr.reduce(edges, 0, (sum, edge) => sum + edge.callCount)
				const unnamed = Arr.filter(edges, nameless)
				const unnamedCalls = Arr.reduce(unnamed, 0, (sum, edge) => sum + edge.callCount)
				if (total === 0 || unnamedCalls / total <= DB_NAMESPACE_MISSING_RATIO) return Result.failVoid
				const named = Arr.filter(edges, (edge) => !nameless(edge))
				const cause: DbIdentityCause = Arr.isReadonlyArrayNonEmpty(named)
					? "split"
					: Arr.every(unnamed, (edge) => edge.dbNamespace === HYPERDRIVE_DB_NAMESPACE)
						? "hyperdrive"
						: "missing"
				const hosts = Arr.filter(unnamed, (edge) => HOST_LIKE.test(edge.dbNamespace))
				const note =
					cause === "split"
						? `${system} split across nodes: ${fmt(unnamedCalls)} calls unnamed; ${Arr.join(
								Arr.map(named, (edge) => `${fmt(edge.callCount)} as \`${edge.dbNamespace}\``),
								", ",
							)}`
						: cause === "hyperdrive"
							? `${system}: namespace is an opaque Hyperdrive id`
							: Arr.isReadonlyArrayNonEmpty(hosts)
								? `${system} node named after the host \`${Arr.headNonEmpty(hosts).dbNamespace}\``
								: `${system} calls carry no \`db.namespace\``
				return Result.succeed({
					cause,
					calls: unnamedCalls,
					entity: { kind: "service" as const, name: first.serviceName, note },
				})
			})
			if (findings.length === 0) return PASS
			// One row per cause, busiest first, so services sharing a cause read as one group.
			const ordered = Arr.sort(
				findings,
				Order.combine(
					Order.mapInput(Order.Number, (row: (typeof findings)[number]) =>
						DB_IDENTITY_CAUSES.indexOf(row.cause),
					),
					Order.mapInput(Order.flip(Order.Number), (row: (typeof findings)[number]) => row.calls),
				),
			)
			const count = (cause: DbIdentityCause) =>
				Arr.filter(findings, (row) => row.cause === cause).length
			const hyperdrive = count("hyperdrive")
			const missing = count("missing")
			const split = count("split")
			const clauses = [
				...(hyperdrive > 0
					? [
							`${plural(hyperdrive, "service")} ${conj(hyperdrive, "connects", "connect")} through Cloudflare Hyperdrive, which reports the binding's opaque id as the database, so every binding collapses into one \`hyperdrive\` node`,
						]
					: []),
				...(missing > 0
					? [
							`${plural(missing, "database dependency", "database dependencies")} ${conj(missing, "arrives", "arrive")} with no database name, so ${conj(missing, "its", "their")} node is named after a host or left blank`,
						]
					: []),
				...(split > 0
					? [
							`${plural(split, "database dependency", "database dependencies")} ${conj(split, "is", "are")} split between a named and an unnamed node`,
						]
					: []),
			]
			const hyperdriveHint =
				"Through Hyperdrive the driver only sees the binding's opaque id, so set it explicitly from your connection config."
			const hints =
				missing + split > 0
					? [MAP_02_GENERIC_HINT, ...(hyperdrive > 0 ? [hyperdriveHint] : [])]
					: [
							"Set `db.namespace` on database client spans to the logical database name.",
							hyperdriveHint,
						]
			return {
				...fail(
					`${Arr.join(clauses, "; ")}.`,
					Arr.map(ordered, (row) => row.entity),
				),
				fixHint: Arr.join(hints, " "),
			}
		},
	},
	{
		id: "MAP-03",
		category: "traces",
		title: "Dependencies are spelled consistently",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Pick one canonical spelling per dependency and use it in every service — Maple treats the strings as distinct nodes.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Group by (key, casefolded value); more than one raw spelling in a group is a collision.
			const spellings = new Map<string, Set<string>>()
			for (const row of warehouse.peerValues) {
				const groupKey = `${row.attributeKey}\x00${Str.toLowerCase(row.attributeValue)}`
				const bucket = spellings.get(groupKey)
				if (bucket) bucket.add(row.attributeValue)
				else spellings.set(groupKey, new Set([row.attributeValue]))
			}
			const collisions = Arr.map(
				Arr.filter([...spellings.entries()], ([, values]) => values.size > 1),
				([groupKey, values]) => ({
					kind: "attribute_key" as const,
					name: Str.split("\x00")(groupKey)[0] ?? "",
					note: Arr.join([...values].sort(), " / "),
				}),
			)
			return collisions.length === 0
				? PASS
				: fail(
						`${plural(collisions.length, "dependency name")} ${conj(collisions.length, "is", "are")} spelled more than one way. Each spelling becomes its own node, fragmenting one logical dependency across the service map.`,
						collisions,
					)
		},
	},
]

// Trace completeness
//
// These read a short, lagged, possibly trace-sampled window, so they speak in rates and never claim
// exact counts. Crucially they cannot detect ingest loss — the warehouse only ever sees what arrived.
// Every finding below is phrased as an internal-consistency result, which is what it actually is.

/** Below this many observed children a service's orphan rate is noise. */
const TRACE_MIN_SAMPLE = 50
/** Orphan share above which the gap is structural rather than incidental. */
const TRACE_GAP_RATIO = 0.1
/** Share of traces without a root span above which TRC-02 warns; it never goes past warn. */
const ROOTLESS_WARN_RATIO = 0.001
/** One rootless trace is a crashed request or a restart; from two on, TRC-02 reports at least `info`. */
const ROOTLESS_MIN_TRACES = 2
/** Above this share, trace context is created upstream of everything instrumented. */
const ROOTLESS_SYSTEMIC_RATIO = 0.95
/** Share of orphans that must sit inside sampled traces before sampling is the better explanation. */
const SAMPLING_EXPLAINS_RATIO = 0.5
/** Sampled hits a service needs before a trace check names it; fewer is anecdote, rolled into a count. */
const TRACE_NAMED_MIN_HITS = 3
/** Routes named per service on TRC-04. */
const INBOUND_ROUTE_LIMIT = 3

/** Orphans whose parent should have arrived: neither dropped by sampling nor sent from outside. */
const missingParents = (row: TraceCompletenessInputs["orphans"][number]): number =>
	row.orphanCount - row.sampledOrphanCount - row.externalParentCount

const traceCompletenessChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "TRC-01",
		category: "traces",
		title: "Spans arrive with their parent",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Either the caller's span never arrived (check its exporter and that `traceparent` survives the hop), or the caller modeled the outbound call as an `Internal` span — which also hides that call from the service map.",
		evaluate: ({ warehouse }) => {
			const traces = warehouse?.traceCompleteness
			if (!traces) return PASS
			const broken = Arr.map(
				Arr.filter(traces.orphans, (row) => {
					if (row.childCount < TRACE_MIN_SAMPLE) return false
					// Sampled orphans are TRC-03's; orphans continuing an outside caller are TRC-04's.
					return missingParents(row) / row.childCount > TRACE_GAP_RATIO
				}),
				(row) => ({
					kind: "service" as const,
					name: row.serviceName,
					note: `${percent(missingParents(row), row.childCount)} of entry spans reference a parent that never arrived${
						row.sampleTraceIds[0] ? ` (e.g. trace ${row.sampleTraceIds[0]})` : ""
					}`,
				}),
			)
			return broken.length === 0
				? PASS
				: fail(
						`${plural(broken.length, "service")} ${conj(broken.length, "receives", "receive")} spans whose parent span is missing, so those traces render as fragments rather than one end-to-end view. Traces that start at an inbound request with no root anywhere are counted under TRC-04 instead: their caller is either an outside client or an upstream service of yours that is not exporting.`,
						broken,
					)
		},
	},
	{
		id: "TRC-02",
		category: "traces",
		title: "Traces have a root span",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"A root span is exported when it ends, so it is the span most often lost: make sure the process flushes the exporter before it exits or is frozen (serverless handlers, CLI commands, worker shutdown). If an uninstrumented proxy or gateway starts the trace, instrument it or let your ingress service start the trace instead. A root that stays open for more than a few minutes (a WebSocket session, a long job) also reads as missing until it ends; start a new trace per message or step and link it instead.",
		evaluate: ({ warehouse }) => {
			const traces = warehouse?.traceCompleteness
			const org = traces?.rootless[0]
			if (!traces || !org) return PASS
			// Sampled traces are the sampler's doing and external-parent ones TRC-04's: neither lost a root.
			const rows = Arr.map(traces.rootless, (row) => ({
				...row,
				missing: row.rootlessCount - row.sampledRootlessCount - row.externalParentCount,
			}))
			const total = org.orgTraceCount - org.orgExternalParentCount
			const missing = org.orgRootlessCount - org.orgSampledRootlessCount - org.orgExternalParentCount
			if (missing < ROOTLESS_MIN_TRACES) return PASS
			const ratio = missing / total
			// Below the minimum sample a rate is noise, so it never escalates past info. A lost root
			// distorts a waterfall but loses no data or alerts, so it caps at warn.
			const severity = total < TRACE_MIN_SAMPLE || ratio <= ROOTLESS_WARN_RATIO ? "info" : "warn"

			// Sampled counts are a fraction of the real ones; say so wherever a count appears.
			const modulus = traces.traceSampleModulus
			const sampleNote = modulus > 1 ? ` in a 1-in-${modulus} sample` : ""
			const losing = Arr.filter(rows, (row) => row.missing > 0)
			const unnamed = Arr.filter(losing, (row) => row.missing < TRACE_NAMED_MIN_HITS).length
			const others =
				unnamed === 0
					? ""
					: ` ${plural(unnamed, "other service")} ${conj(unnamed, "loses", "lose")} a root on fewer than ${TRACE_NAMED_MIN_HITS} sampled traces${conj(unnamed, "", " each")}.`
			const affected = Arr.map(
				Arr.filter(losing, (row) => row.missing >= TRACE_NAMED_MIN_HITS).sort(
					(a, b) => b.missing - a.missing,
				),
				(row) => ({
					kind: "service" as const,
					name: row.entryService,
					note: `${sharePercent(row.missing, row.traceCount)} of traces starting here have no root (${row.missing} of ${row.traceCount}${sampleNote})`,
				}),
			)

			// One upstream fact, not N service defects — but only when every sizable service shows it,
			// so the rows must cover every trace (none cut by the query's row cap).
			const sizable = Arr.filter(rows, (row) => row.traceCount >= TRACE_MIN_SAMPLE)
			const everyService = Arr.reduce(rows, 0, (sum, row) => sum + row.traceCount) === org.orgTraceCount
			const systemic =
				ratio > ROOTLESS_SYSTEMIC_RATIO &&
				everyService &&
				sizable.length > 0 &&
				Arr.every(sizable, (row) => row.missing / row.traceCount > ROOTLESS_SYSTEMIC_RATIO)
			if (systemic) {
				return {
					...fail(
						"Essentially every trace arrives without a root span, across all services. Trace context is being created upstream of your instrumented services — typically a proxy, gateway or load balancer that injects `traceparent` but exports no spans of its own.",
						affected,
					),
					severity,
				}
			}

			const perHour = Math.round((missing * modulus * 60) / traces.windowMinutes)
			const counts =
				modulus > 1
					? `about ${perHour.toLocaleString("en-US")} traces an hour, estimated from a 1-in-${modulus} trace sample over ${plural(traces.windowMinutes, "minute")}`
					: `${missing} of ${total} traces over ${plural(traces.windowMinutes, "minute")}`
			return {
				...fail(
					`${sharePercent(missing, total)} of traces have no root span: ${counts}. Their duration and waterfall start at the first span that did arrive, so both are wrong.${others}`,
					affected,
				),
				severity,
			}
		},
	},
	{
		id: "TRC-03",
		category: "traces",
		title: "Sampling is applied consistently across services",
		severity: "info",
		needsWarehouse: true,
		fixHint:
			"Use a consistent-probability sampler with the same ratio in every service, and propagate the sampling decision — otherwise a kept child can lose its dropped parent.",
		evaluate: ({ warehouse }) => {
			const traces = warehouse?.traceCompleteness
			if (!traces) return PASS
			const sampled = Arr.map(
				Arr.filter(
					traces.orphans,
					(row) =>
						row.orphanCount > 0 &&
						row.childCount >= TRACE_MIN_SAMPLE &&
						row.sampledOrphanCount / row.orphanCount > SAMPLING_EXPLAINS_RATIO,
				),
				(row) => ({
					kind: "service" as const,
					name: row.serviceName,
					note: `${percent(row.sampledOrphanCount, row.orphanCount)} of its incomplete traces were sampling-marked`,
				}),
			)
			return sampled.length === 0
				? PASS
				: fail(
						`${plural(sampled.length, "service")} ${conj(sampled.length, "receives", "receive")} spans whose parent was dropped by sampling. Nothing is broken, but those traces are partial — services that disagree about sampling ratios produce exactly this.`,
						sampled,
					)
		},
	},
	{
		id: "TRC-04",
		category: "traces",
		title: "Inbound requests start their own traces",
		severity: "info",
		needsWarehouse: true,
		fixHint:
			"On a public endpoint, start a new trace for each inbound request and keep the caller's context as a span link instead of its parent, so the trace has a root you own. If the callers are yours, instrument and export them instead. Continuing the caller's trace is fine when deliberate; nothing is lost either way.",
		evaluate: ({ warehouse }) => {
			const traces = warehouse?.traceCompleteness
			if (!traces) return PASS
			const routes = Arr.groupBy(traces.inboundRoutes, (row) => row.serviceName)
			const rootless = new Map(
				Arr.map(traces.rootless, (row) => [row.entryService, row.externalParentCount] as const),
			)
			const orphans = new Map(
				Arr.map(traces.orphans, (row) => [row.serviceName, row.externalParentCount] as const),
			)
			// Entry spans whose parent did arrive: instrumented services call this one too.
			const inOrgCallers = new Set(
				Arr.map(
					Arr.filter(traces.orphans, (row) => row.childCount > row.orphanCount),
					(row) => row.serviceName,
				),
			)
			const services = Arr.dedupe([...rootless.keys(), ...orphans.keys()])
			const modulus = traces.traceSampleModulus
			const sampleNote = modulus > 1 ? ` in a 1-in-${modulus} sample` : ""
			const external = Arr.filterMap(services, (serviceName) => {
				const traceCount = rootless.get(serviceName) ?? 0
				const spanCount = orphans.get(serviceName) ?? 0
				if (traceCount === 0 && spanCount === 0) return Result.failVoid
				const top = Arr.take(routes[serviceName] ?? [], INBOUND_ROUTE_LIMIT)
				const via = Arr.isReadonlyArrayNonEmpty(top)
					? `, mostly via ${Arr.join(
							Arr.map(top, (row) =>
								row.route === ""
									? "an unrouted request"
									: `\`${quoteSafely(Str.replace(/[?#].*$/, "")(row.route))}\``,
							),
							", ",
						)}`
					: ""
				const counted =
					traceCount > 0
						? `${plural(traceCount, "trace")} started by an outside caller`
						: `${plural(spanCount, "inbound span")} continuing an outside caller's trace`
				return Result.succeed({
					// The count the note shows, so a service is named on the evidence it is described by.
					weight: traceCount > 0 ? traceCount : spanCount,
					entity: {
						kind: "service" as const,
						name: serviceName,
						note: `${counted}${sampleNote}${via}${
							inOrgCallers.has(serviceName)
								? "; your instrumented services call it too, so the missing caller may be one of yours"
								: ""
						}`,
					},
				})
			})
			const total = Arr.reduce(external, 0, (sum, row) => sum + row.weight)
			// A service with one or two such traces is an anecdote; only repeated evidence is named.
			const named = Arr.filter(external, (row) => row.weight >= TRACE_NAMED_MIN_HITS)
			if (total < ROOTLESS_MIN_TRACES || named.length === 0) return PASS
			const sorted = Arr.map(
				Arr.sort(
					named,
					Order.mapInput(Order.flip(Order.Number), (row: (typeof external)[number]) => row.weight),
				),
				(row) => row.entity,
			)
			const unnamed = external.length - named.length
			const others =
				unnamed === 0
					? ""
					: ` ${plural(unnamed, "other service")} ${conj(unnamed, "sees", "see")} fewer than ${TRACE_NAMED_MIN_HITS} such traces${conj(unnamed, "", " each")}.`
			return fail(
				`${plural(sorted.length, "service")} ${conj(sorted.length, "receives", "receive")} requests that carry a \`traceparent\` from outside what Maple received: either an outside client (a public API or MCP client) or an upstream service of yours that is not exporting spans. Those traces have no root here, so they are left out of TRC-01 and TRC-02.${others}`,
				sorted,
			)
		},
	},
]

export const SETUP_AUDIT_CHECKS: ReadonlyArray<AuditCheck> = [
	...alertingChecks,
	...notificationChecks,
	...ingestionChecks,
	...ingestCoverageChecks,
	...attributeQualityChecks,
	...serviceMapChecks,
	...traceCompletenessChecks,
	...platformChecks,
	...integrationChecks,
]

// Runner

const emptySummary: SetupAuditSummary = { critical: 0, warn: 0, info: 0, pass: 0, skip: 0 }

/**
 * Evaluate every check against one input snapshot.
 *
 * Two short-circuits worth knowing about:
 *  - An org that has never received telemetry returns `no_data` with zero checks. Twenty failing
 *    checks against an org that hasn't connected yet is noise; the onboarding checklist owns that phase.
 *  - When the warehouse is unreachable, `needsWarehouse` checks report `skip` rather than failing the
 *    request, so the config half of the audit still lands.
 *
 * Telemetry checks see the snapshot without Maple-written services ({@link withoutMapleServices}).
 */
export function runSetupAudit(inputs: SetupAuditInputs): SetupAuditReport {
	const warehouseAvailable = inputs.warehouse !== undefined

	if (inputs.config.telemetry === "absent") {
		return {
			generatedAt: inputs.now,
			dataStatus: "no_data",
			warehouseAvailable,
			summary: emptySummary,
			checks: [],
			openRecommendationCount: inputs.config.openRecommendationCount,
		}
	}

	const checks: AuditCheckResult[] = []
	const summary = { ...emptySummary }
	// Maple-written services leave every per-service input once, here, rather than in each check.
	const scoped: SetupAuditInputs =
		inputs.warehouse === undefined
			? inputs
			: { ...inputs, warehouse: withoutMapleServices(inputs.warehouse) }

	for (const check of SETUP_AUDIT_CHECKS) {
		if (check.needsWarehouse === true && !warehouseAvailable) {
			summary.skip += 1
			checks.push({
				id: check.id,
				category: check.category,
				title: check.title,
				severity: check.severity,
				status: "skip",
				detail: "Requires telemetry data, which is currently unavailable.",
				affected: [],
				affectedCount: 0,
				fixHint: check.fixHint,
			})
			continue
		}

		const evaluation = check.evaluate(scoped)
		const severity = evaluation.severity ?? check.severity
		if (evaluation.status === "pass") summary.pass += 1
		else summary[severity] += 1

		checks.push({
			id: check.id,
			category: check.category,
			title: check.title,
			severity,
			status: evaluation.status,
			detail: evaluation.detail ?? null,
			affected: evaluation.affected ?? [],
			affectedCount: evaluation.affectedCount ?? evaluation.affected?.length ?? 0,
			fixHint: evaluation.fixHint ?? check.fixHint,
		})
	}

	return {
		generatedAt: inputs.now,
		dataStatus: "ok",
		warehouseAvailable,
		summary,
		checks,
		openRecommendationCount: inputs.config.openRecommendationCount,
	}
}
