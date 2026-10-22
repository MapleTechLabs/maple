/**
 * The app section of the cancellation evidence: what the org set up and used
 * in Maple, read from Postgres as small aggregates. Each part is its own read
 * and is null when that read fails or is slow; the rest still arrive.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import {
	Actors,
	AgentFeedback,
	AlertDeliveryEvents,
	AlertDestinations,
	AlertIncidents,
	AlertRules,
	AlertRuleStates,
	AnomalyDetectorSettings,
	AnomalyIncidents,
	ApiKeys,
	CancellationReviews,
	DigestSubscriptions,
	ErrorIssueEvents,
	ErrorIssues,
	GcpConnectors,
	Investigations,
	OrgOnboardingState,
	ScrapeTargetChecks,
	ScrapeTargets,
	type SourceRow,
	Sources,
} from "@maple/db/tables"
import type {
	CancellationAgentFeedback,
	CancellationAlertsEvidence,
	CancellationApiKeysEvidence,
	CancellationAppEvidence,
	CancellationErrorClass,
	CancellationIntegrationHealth,
	CancellationLifecycleEmail,
	CancellationOnboardingEvidence,
	CancellationPriorReview,
	CancellationScrapeEvidence,
} from "@maple/domain/http"
import { INTEGRATION_PROVIDERS, type IntegrationInventory } from "@maple/domain/integration-inventory"
import {
	SOURCE_HEALTH_STATUSES,
	type SourceHealthStatus,
	worstSourceStatus,
} from "@maple/domain/source-health"
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { SOURCE_HEALTH_COLUMNS, sourceRowHealth } from "@maple/backend/services/org/source-rows"
import {
	type CancellationEvidenceInput,
	daysBeforeCancel,
	EVIDENCE_GRACE_MS,
	knownAtCancel,
	redactText,
} from "./evidence-input"
import { DAY_MS } from "./snapshot"

const WINDOW_MS = 30 * DAY_MS
const FEEDBACK_WINDOW_MS = 90 * DAY_MS
/** A cancellation this close to the reviewed one is the same cancellation. */
const SAME_CANCELLATION_MS = 2 * DAY_MS
/** Eleven reads, three at a time: each must leave room for the rest within the section's budget. */
const SUB_READ_TIMEOUT = "3 seconds"
const INTEGRATIONS_SHOWN = 15
const DESTINATIONS_SHOWN = 10
const MUTED_SIGNALS_SHOWN = 10
const FEEDBACK_SHOWN = 5
const PRIOR_REVIEWS_SHOWN = 5
/** Scrape checks are read per target id: the table has no org index. */
const SCRAPE_TARGETS_CHECKED = 200
const SUMMARY_CHARS = 200
const OPEN_ISSUE_STATES = ["triage", "regressed", "todo", "in_progress", "in_review"] as const

/**
 * Days before the cancellation of a "last time" a row keeps (last success, last
 * use). A review can run after the cancellation, when those have moved past
 * it: still in use then reads as 0, never as a day after it.
 */
const days = (atMs: number, ms: number | null): number | null =>
	ms === null ? null : Math.max(0, daysBeforeCancel(atMs, ms))

const newest = (values: ReadonlyArray<number | null>): number | null =>
	values.reduce<number | null>(
		(max, value) => (value !== null && (max === null || value > max) ? value : max),
		null,
	)

const isBroken = (status: SourceHealthStatus) => status === "failing" || status === "disconnected"

/** An error message reduced to its kind, so the message itself never reaches the model. */
export const errorClassOf = (message: string): CancellationErrorClass => {
	if (/timed? ?out|deadline/i.test(message)) return "timeout"
	if (/\b429\b|rate.?limit|too many requests|quota/i.test(message)) return "rate_limited"
	if (
		/\b40[13]\b|unauthori[sz]ed|forbidden|auth|credential|token|permission|expired|revoked/i.test(message)
	)
		return "auth"
	if (/\b404\b|not[ _]?found|no such|does not exist|deleted/i.test(message)) return "not_found"
	if (/econnrefused|enotfound|connection (refused|reset)|unreachable|dns|tls|certificate/i.test(message))
		return "unreachable"
	return "other"
}

export type SourceHealthRow = Pick<SourceRow, (typeof SOURCE_HEALTH_COLUMNS)[number]>

export interface GcpConnectorHealthRow {
	readonly lastReceivedAt: number | null
	readonly lastMetricsReceivedAt: number | null
	readonly lastError: string | null
	readonly lastMetricsError: string | null
	readonly lastResourcesError: string | null
}

const PROVIDERS: ReadonlySet<string> = new Set(INTEGRATION_PROVIDERS)
/**
 * SDK tokens, shown only when something is wrong with them. Whether their
 * telemetry arrives is the telemetry section's to say; a token's own status
 * reads "pending" whenever the org sends with its ingest key instead, which on
 * real orgs was nearly always.
 */
const SDK_PLATFORMS: ReadonlySet<string> = new Set([
	"opentelemetry",
	"nodejs",
	"python",
	"go",
	"java",
	"dotnet",
	"ruby",
	"php",
	"rust",
	"browser",
])

/**
 * The inventory's integrations, plus the ingest sources it leaves out (SDK
 * tokens with a problem, GCP, Claude Code, ...) one entry per platform. A GCP connector's errors clear on
 * its next success, so one that is set is a current error.
 */
export const integrationHealthOf = (
	inventory: IntegrationInventory,
	sources: ReadonlyArray<SourceHealthRow>,
	gcpConnectors: ReadonlyArray<GcpConnectorHealthRow>,
	atMs: number,
	now: number,
): ReadonlyArray<CancellationIntegrationHealth> => {
	const integrations = inventory.integrations.map((entry): CancellationIntegrationHealth => ({
		kind: entry.provider,
		status: entry.status,
		lastSuccessDaysBeforeCancel: days(atMs, newest(entry.resources.map((r) => r.lastSuccessAt))),
		lastErrorDaysBeforeCancel: null,
		errorClass: isBroken(entry.status) ? errorClassOf(entry.problem ?? "") : null,
	}))
	const byPlatform = new Map<string, Array<SourceHealthRow>>()
	for (const source of sources) {
		if (PROVIDERS.has(source.platform)) continue
		byPlatform.set(source.platform, [...(byPlatform.get(source.platform) ?? []), source])
	}
	const platforms = [...byPlatform].map(([platform, rows]): CancellationIntegrationHealth => {
		const healths = rows.map((row) => sourceRowHealth(row, now))
		const status = worstSourceStatus(healths.map((health) => health.status))
		const connectors = platform === "gcp" ? gcpConnectors : []
		const connectorError = connectors
			.flatMap((c) => [c.lastError, c.lastMetricsError, c.lastResourcesError])
			.find((error) => error !== null)
		const problem = healths.find((health) => health.status === status)?.problem ?? null
		return {
			kind: platform,
			status,
			lastSuccessDaysBeforeCancel: days(
				atMs,
				newest([
					...healths.map((health) => health.lastDataAt),
					...connectors.flatMap((c) => [c.lastReceivedAt, c.lastMetricsReceivedAt]),
				]),
			),
			lastErrorDaysBeforeCancel: days(
				atMs,
				newest(
					rows.map((row) =>
						row.lastRejectedAt !== null && knownAtCancel(atMs, row.lastRejectedAt)
							? row.lastRejectedAt
							: null,
					),
				),
			),
			errorClass: isBroken(status)
				? errorClassOf(problem ?? "")
				: connectorError === undefined
					? null
					: errorClassOf(connectorError),
		}
	})
	const shown = platforms.filter(
		(entry) =>
			!SDK_PLATFORMS.has(entry.kind) ||
			isBroken(entry.status) ||
			entry.lastErrorDaysBeforeCancel !== null,
	)
	// Worst first.
	return [...integrations, ...shown]
		.toSorted(
			(a, b) => SOURCE_HEALTH_STATUSES.indexOf(a.status) - SOURCE_HEALTH_STATUSES.indexOf(b.status),
		)
		.slice(0, INTEGRATIONS_SHOWN)
}

export interface OnboardingRow {
	readonly demoDataRequested: boolean
	readonly onboardingCompletedAt: number | null
	readonly checklistDismissedAt: number | null
	readonly firstDataReceivedAt: number | null
	readonly welcomeEmailSentAt: number | null
	readonly connectNudgeEmailSentAt: number | null
	readonly stalledEmailSentAt: number | null
	readonly activationEmailSentAt: number | null
	readonly createdAt: number
}

/** `row` is null when the org never reached onboarding. */
export const onboardingOf = (row: OnboardingRow | null, atMs: number): CancellationOnboardingEvidence => {
	if (row === null) {
		return {
			recorded: false,
			completed: false,
			checklistDismissed: false,
			demoDataRequested: false,
			firstDataDaysBeforeCancel: null,
			signupToFirstDataDays: null,
			lifecycleEmailsSent: [],
		}
	}
	const emails: ReadonlyArray<readonly [CancellationLifecycleEmail, number | null]> = [
		["welcome", row.welcomeEmailSentAt],
		["connect_nudge", row.connectNudgeEmailSentAt],
		["stalled", row.stalledEmailSentAt],
		["activation", row.activationEmailSentAt],
	]
	const known = (ms: number | null): ms is number => ms !== null && knownAtCancel(atMs, ms)
	const firstData = known(row.firstDataReceivedAt) ? row.firstDataReceivedAt : null
	return {
		recorded: true,
		completed: known(row.onboardingCompletedAt),
		checklistDismissed: known(row.checklistDismissedAt),
		demoDataRequested: row.demoDataRequested,
		firstDataDaysBeforeCancel: days(atMs, firstData),
		signupToFirstDataDays:
			firstData === null ? null : Math.max(0, Math.floor((firstData - row.createdAt) / DAY_MS)),
		lifecycleEmailsSent: emails
			.filter((email): email is readonly [CancellationLifecycleEmail, number] => known(email[1]))
			.toSorted((a, b) => a[1] - b[1])
			.map(([name]) => name),
	}
}

export interface DestinationRow {
	readonly type: string
	readonly createdAt: number
	readonly enabled: boolean
	readonly disabledAt: number | null
	readonly disabledReason: string | null
}

/** The destinations that existed at the cancellation. */
export const destinationsAtCancel = (rows: ReadonlyArray<DestinationRow>, atMs: number) =>
	rows.filter((row) => knownAtCancel(atMs, row.createdAt))

/**
 * Auto-disabling stamps `disabledAt` and the failure, so one auto-disabled
 * after the cancellation was still on then; a person switching it off stamps
 * neither, so that one is as of now.
 */
export const disabledDestinationsOf = (
	rows: ReadonlyArray<DestinationRow>,
	atMs: number,
): CancellationAlertsEvidence["disabledDestinations"] =>
	destinationsAtCancel(rows, atMs)
		.filter((row) => !row.enabled && (row.disabledAt === null || knownAtCancel(atMs, row.disabledAt)))
		.slice(0, DESTINATIONS_SHOWN)
		.map((row) => ({
			type: row.type,
			reason:
				row.disabledAt === null
					? "manual"
					: row.disabledReason?.startsWith("Last recipient left")
						? "recipient_left"
						: errorClassOf(row.disabledReason ?? ""),
		}))

export interface FeedbackRow {
	readonly createdAt: number
	readonly kind: string
	readonly impact: string | null
	readonly summary: string
}

export const agentFeedbackOf = (row: FeedbackRow, atMs: number): CancellationAgentFeedback => ({
	daysBeforeCancel: daysBeforeCancel(atMs, row.createdAt),
	kind: row.kind,
	impact: row.impact,
	summary: redactText(row.summary, SUMMARY_CHARS),
})

export interface PriorReviewRow {
	readonly canceledAt: number | null
	readonly createdAt: number
	readonly ruleReason: string | null
	/** The stored model read, undecoded: older rows predate its current fields. */
	readonly modelRead: unknown
}

const decodeCategory = Schema.decodeUnknownOption(Schema.Struct({ category: Schema.NullOr(Schema.String) }))

/** Rows newest first; the reviewed cancellation itself is dropped. */
export const priorReviewsOf = (
	rows: ReadonlyArray<PriorReviewRow>,
	atMs: number,
): ReadonlyArray<CancellationPriorReview> =>
	rows
		.map((row) => ({ row, at: row.canceledAt ?? row.createdAt }))
		// Earlier ones only: this one, or a later one, is not part of why it left now.
		.filter(({ at }) => at < atMs - SAME_CANCELLATION_MS)
		.slice(0, PRIOR_REVIEWS_SHOWN)
		.map(({ row, at }) => ({
			daysBeforeCancel: daysBeforeCancel(atMs, at),
			ruleReason: row.ruleReason,
			modelCategory: Option.match(decodeCategory(row.modelRead), {
				onNone: () => null,
				onSome: (read) => read.category,
			}),
		}))

export const scrapeEvidenceOf = (
	targets: {
		readonly targets: number
		readonly enabledTargets: number
		readonly lastScrapeAt: number | null
	},
	/** Null when the checks before the cancellation are already pruned. */
	checks: { readonly checks: number; readonly failed: number } | null,
	atMs: number,
): CancellationScrapeEvidence => ({
	targets: targets.targets,
	enabledTargets: targets.enabledTargets,
	checksLastDay: checks === null ? null : checks.checks,
	failedCheckShareLastDay: checks === null || checks.checks === 0 ? null : checks.failed / checks.checks,
	lastSuccessDaysBeforeCancel: days(atMs, targets.lastScrapeAt),
})

export const apiKeysOf = (
	rows: ReadonlyArray<{
		readonly kind: string
		readonly active: number
		readonly lastUsedAt: number | null
	}>,
	atMs: number,
): CancellationApiKeysEvidence => {
	const active = (kind: string) => rows.find((row) => row.kind === kind)?.active ?? 0
	return {
		active: { standard: active("standard"), mcp: active("mcp"), device: active("device") },
		lastUsedDaysBeforeCancel: days(atMs, newest(rows.map((row) => row.lastUsedAt))),
	}
}

type Query<A> = (db: MapleDb) => Effect.Effect<ReadonlyArray<A>, MapleDbError>

export class CancellationAppEvidenceReader extends Context.Service<
	CancellationAppEvidenceReader,
	{ readonly read: (input: CancellationEvidenceInput) => Effect.Effect<CancellationAppEvidence> }
>()("@maple/backend/cancellation-review/CancellationAppEvidenceReader", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const inventory = yield* IntegrationInventoryService

		const rows = <A>(query: Query<A>) => database.execute(query)
		/** An aggregate without GROUP BY always answers one row. */
		const one = <A>(query: Query<A>) =>
			rows(query).pipe(Effect.flatMap((result) => Effect.fromNullishOr(result[0])))

		/** One part of the section: null when it fails or is slow, never the end of the section. */
		const part = <A, E>(name: string, read: Effect.Effect<A, E>): Effect.Effect<A | null> =>
			read.pipe(
				Effect.timeout(SUB_READ_TIMEOUT),
				Effect.map((value): A | null => value),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("cancellation app evidence could not read a part").pipe(
								Effect.annotateLogs({ part: name, error: summarizeCause(cause) }),
								Effect.as(null),
							),
				),
				Effect.withSpan(`CancellationAppEvidenceReader.${name}`),
			)

		const readIntegrations = ({ orgId, atMs }: CancellationEvidenceInput) =>
			Effect.gen(function* () {
				const listed = yield* inventory.list(orgId)
				const sources = yield* rows((db) =>
					db.run(
						PG.from(Sources)
							.select(...SOURCE_HEALTH_COLUMNS)
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				const gcp = yield* rows((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select(
								"lastReceivedAt",
								"lastMetricsReceivedAt",
								"lastError",
								"lastMetricsError",
								"lastResourcesError",
							)
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				return integrationHealthOf(listed, sources, gcp, atMs, yield* Clock.currentTimeMillis)
			})

		const readOnboarding = ({ orgId, atMs }: CancellationEvidenceInput) =>
			rows((db) =>
				db.run(
					PG.from(OrgOnboardingState)
						.select(
							"demoDataRequested",
							"onboardingCompletedAt",
							"checklistDismissedAt",
							"firstDataReceivedAt",
							"welcomeEmailSentAt",
							"connectNudgeEmailSentAt",
							"stalledEmailSentAt",
							"activationEmailSentAt",
							"createdAt",
						)
						.where(($) => [$.orgId.eq(orgId)]),
				),
			).pipe(Effect.map((result) => onboardingOf(result[0] ?? null, atMs)))

		const readAlerts = ({ orgId, atMs }: CancellationEvidenceInput) =>
			Effect.gen(function* () {
				const cutoff = atMs + EVIDENCE_GRACE_MS
				const recentStart = atMs - WINDOW_MS
				const priorStart = atMs - 2 * WINDOW_MS
				const rules = yield* one((db) =>
					db.run(
						PG.from(AlertRules)
							.select(($) => ({
								enabled: PG.countIf($.enabled.eq(true)),
								disabled: PG.countIf($.enabled.eq(false)),
							}))
							.where(($) => [$.orgId.eq(orgId), $.createdAt.lte(cutoff)]),
					),
				)
				const failing = yield* one((db) =>
					db.run(
						PG.from(AlertRuleStates)
							.innerJoin(AlertRules, "r", (state, rule) => rule.id.eq(state.ruleId))
							.select(($) => ({ count: PG.countDistinct($.ruleId) }))
							.where(($) => [
								$.orgId.eq(orgId),
								$.r.orgId.eq(orgId),
								$.r.enabled.eq(true),
								$.r.createdAt.lte(cutoff),
								$.lastError.isNotNull(),
							]),
					),
				)
				const incidents = yield* one((db) =>
					db.run(
						PG.from(AlertIncidents)
							.select(($) => {
								const recent = $.firstTriggeredAt
									.gte(recentStart)
									.and($.firstTriggeredAt.lt(atMs))
								return {
									recent: PG.countIf(recent),
									prior: PG.countIf($.firstTriggeredAt.lt(recentStart)),
									medianMinutes: PG.sql(
										PG.nullable(PG.float8),
									)`(percentile_cont(0.5) within group (order by extract(epoch from (${$.resolvedAt} - ${$.firstTriggeredAt})) / 60) filter (where ${recent} and ${$.resolvedAt} is not null))::float8`,
								}
							})
							.where(($) => [
								$.orgId.eq(orgId),
								$.firstTriggeredAt.gte(priorStart),
								$.firstTriggeredAt.lt(atMs),
							]),
					),
				)
				const deliveries = yield* one((db) =>
					db.run(
						PG.from(AlertDeliveryEvents)
							.select(($) => ({
								sent: PG.countIf($.status.eq("success")),
								failed: PG.countIf($.status.eq("failed")),
							}))
							.where(($) => [
								$.orgId.eq(orgId),
								$.createdAt.gte(recentStart),
								$.createdAt.lt(atMs),
							]),
					),
				)
				const destinations = yield* rows((db) =>
					db.run(
						PG.from(AlertDestinations)
							.select("type", "createdAt", "enabled", "disabledAt", "disabledReason")
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				return {
					enabledRules: rules.enabled,
					disabledRules: rules.disabled,
					failingRules: failing.count,
					incidentsRecent: incidents.recent,
					incidentsPrior: incidents.prior,
					medianIncidentMinutesRecent:
						incidents.medianMinutes === null ? null : Math.round(incidents.medianMinutes),
					notificationsSentRecent: deliveries.sent,
					deliveryFailuresRecent: deliveries.failed,
					destinations: destinationsAtCancel(destinations, atMs).length,
					disabledDestinations: disabledDestinationsOf(destinations, atMs),
				} satisfies CancellationAlertsEvidence
			})

		const readAnomalies = ({ orgId, atMs }: CancellationEvidenceInput) =>
			Effect.gen(function* () {
				const incidents = yield* one((db) =>
					db.run(
						PG.from(AnomalyIncidents)
							.select(($) => ({
								recent: PG.count(),
								reopened: PG.countIf($.reopenCount.gt(0)),
							}))
							.where(($) => [
								$.orgId.eq(orgId),
								$.firstTriggeredAt.gte(atMs - WINDOW_MS),
								$.firstTriggeredAt.lt(atMs),
							]),
					),
				)
				// No settings row is the zero-config default: enabled, nothing muted.
				const settings = yield* rows((db) =>
					db.run(
						PG.from(AnomalyDetectorSettings)
							.select("enabled", "mutedSignalsJson")
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				return {
					incidentsRecent: incidents.recent,
					reopenedRecent: incidents.reopened,
					detectorEnabled: settings[0]?.enabled ?? true,
					mutedSignals: (settings[0]?.mutedSignalsJson ?? []).slice(0, MUTED_SIGNALS_SHOWN),
				}
			})

		const readInvestigations = ({ orgId, atMs }: CancellationEvidenceInput) =>
			one((db) =>
				db.run(
					PG.from(Investigations)
						.select(($) => ({
							recent: PG.count(),
							userStarted: PG.countIf($.seededBy.eq("user")),
							automatic: PG.countIf($.seededBy.eq("system")),
							failed: PG.countIf($.status.eq("failed")),
							lowConfidence: PG.countIf($.status.eq("inconclusive").or($.confidence.eq("low"))),
						}))
						.where(($) => [
							$.orgId.eq(orgId),
							$.createdAt.gte(atMs - WINDOW_MS),
							$.createdAt.lt(atMs),
						]),
				),
			)

		const readErrorIssues = ({ orgId, atMs }: CancellationEvidenceInput) =>
			Effect.gen(function* () {
				const recentStart = atMs - WINDOW_MS
				const cutoff = atMs + EVIDENCE_GRACE_MS
				const issues = yield* one((db) =>
					db.run(
						PG.from(ErrorIssues)
							.select(($) => ({
								// Resolved or archived after the cancellation was still open at it.
								open: PG.countIf(
									$.firstSeenAt
										.lte(cutoff)
										.and(PG.or($.archivedAt.isNull(), $.archivedAt.gt(cutoff)))
										.and(
											PG.or(
												$.workflowState.in_(...OPEN_ISSUE_STATES),
												$.lastResolvedAt.gt(cutoff),
											),
										),
								),
								firstSeenRecent: PG.countIf(
									$.firstSeenAt.gte(recentStart).and($.firstSeenAt.lt(atMs)),
								),
							}))
							.where(($) => [$.orgId.eq(orgId), $.kind.eq("error")]),
					),
				)
				const actions = yield* one((db) =>
					db.run(
						PG.from(ErrorIssueEvents)
							.innerJoin(Actors, "a", (event, actor) => event.actorId.eq(actor.id))
							.select(($) => ({
								recent: PG.countIf($.createdAt.gte(recentStart)),
								prior: PG.countIf($.createdAt.lt(recentStart)),
							}))
							.where(($) => [
								$.orgId.eq(orgId),
								$.a.orgId.eq(orgId),
								$.a.type.eq("user"),
								$.createdAt.gte(atMs - 2 * WINDOW_MS),
								$.createdAt.lt(atMs),
							]),
					),
				)
				return {
					open: issues.open,
					firstSeenRecent: issues.firstSeenRecent,
					userActionsRecent: actions.recent,
					userActionsPrior: actions.prior,
				}
			})

		const readAgentFeedback = ({ orgId, atMs }: CancellationEvidenceInput) =>
			rows((db) =>
				db.run(
					PG.from(AgentFeedback)
						.select("createdAt", "kind", "impact", "summary")
						.where(($) => [
							$.orgId.eq(orgId),
							$.createdAt.gte(atMs - FEEDBACK_WINDOW_MS),
							$.createdAt.lte(atMs + EVIDENCE_GRACE_MS),
						])
						.orderBy(($) => [[$.createdAt, "desc"]])
						.limit(FEEDBACK_SHOWN),
				),
			).pipe(Effect.map((result) => result.map((row) => agentFeedbackOf(row, atMs))))

		const readPriorCancellations = ({ orgId, atMs }: CancellationEvidenceInput) =>
			rows((db) =>
				db.run(
					PG.from(CancellationReviews)
						.select(($) => ({
							canceledAt: $.canceledAt,
							createdAt: $.createdAt,
							ruleReason: PG.undecoded($.ruleReason),
							modelRead: PG.undecoded($.modelRead),
						}))
						.where(($) => [$.orgId.eq(orgId), $.postedAt.isNotNull()])
						.orderBy(($) => [[$.createdAt, "desc"]])
						// The reviewed cancellation and a duplicate of it can take two of these.
						.limit(PRIOR_REVIEWS_SHOWN + 2),
				),
			).pipe(Effect.map((result) => priorReviewsOf(result, atMs)))

		const readScrapeTargets = ({ orgId, atMs }: CancellationEvidenceInput) =>
			Effect.gen(function* () {
				const cutoff = atMs + EVIDENCE_GRACE_MS
				const targets = yield* one((db) =>
					db.run(
						PG.from(ScrapeTargets)
							.select(($) => ({
								targets: PG.count(),
								enabledTargets: PG.countIf($.enabled.eq(true)),
								lastScrapeAt: PG.max($.lastScrapeAt),
							}))
							.where(($) => [$.orgId.eq(orgId), $.createdAt.lte(cutoff)]),
					),
				)
				const ids = yield* rows((db) =>
					db.run(
						PG.from(ScrapeTargets)
							.select("id")
							.where(($) => [$.orgId.eq(orgId), $.createdAt.lte(cutoff)])
							.limit(SCRAPE_TARGETS_CHECKED),
					),
				)
				// Checks are kept 24 hours: a late review finds the day before the cancellation pruned.
				const pruned = !knownAtCancel(atMs, yield* Clock.currentTimeMillis)
				const checks = pruned
					? null
					: ids.length === 0
						? { checks: 0, failed: 0 }
						: yield* one((db) =>
								db.run(
									PG.from(ScrapeTargetChecks)
										.select(($) => ({
											checks: PG.count(),
											failed: PG.countIf($.error.isNotNull()),
										}))
										.where(($) => [
											$.orgId.eq(orgId),
											$.targetId.in_(...ids.map((row) => row.id)),
											$.checkedAt.gte(atMs - DAY_MS),
											$.checkedAt.lt(atMs),
										]),
								),
							)
				return scrapeEvidenceOf(targets, checks, atMs)
			})

		const readApiKeys = ({ orgId, atMs }: CancellationEvidenceInput) =>
			rows((db) => {
				const cutoff = atMs + EVIDENCE_GRACE_MS
				return db.run(
					PG.from(ApiKeys)
						.select(($) => ({
							kind: PG.undecoded($.kind),
							// Revoked after the cancellation was still in use at it.
							active: PG.countIf(
								PG.or($.revoked.eq(false), $.revokedAt.gt(cutoff)).and(
									PG.or($.expiresAt.isNull(), $.expiresAt.gt(atMs)),
								),
							),
							lastUsedAt: PG.max($.lastUsedAt),
						}))
						.where(($) => [$.orgId.eq(orgId), $.createdAt.lte(cutoff)])
						.groupBy("kind"),
				)
			}).pipe(Effect.map((result) => apiKeysOf(result, atMs)))

		const readDigest = ({ orgId, atMs }: CancellationEvidenceInput) =>
			one((db) => {
				const cutoff = atMs + EVIDENCE_GRACE_MS
				return db.run(
					PG.from(DigestSubscriptions)
						.select(($) => {
							const optedOutThen = $.optedOutAt.lte(cutoff)
							return {
								// Opted out after the cancellation was still subscribed at it.
								subscribers: PG.countIf(PG.or($.enabled.eq(true), $.optedOutAt.gt(cutoff))),
								optedOut: PG.countIf(optedOutThen),
								lastOptOutAt: PG.sql(
									PG.nullable(PG.timestamptzMillis),
								)`max(${$.optedOutAt}) filter (where ${optedOutThen})`,
							}
						})
						.where(($) => [$.orgId.eq(orgId), $.createdAt.lte(cutoff)]),
				)
			}).pipe(
				Effect.map((digest) => ({
					subscribers: digest.subscribers,
					optedOut: digest.optedOut,
					lastOptOutDaysBeforeCancel: days(atMs, digest.lastOptOutAt),
				})),
			)

		const read = Effect.fn("CancellationAppEvidenceReader.read")(function* (
			input: CancellationEvidenceInput,
		) {
			return yield* Effect.all(
				{
					integrations: part("readIntegrations", readIntegrations(input)),
					onboarding: part("readOnboarding", readOnboarding(input)),
					alerts: part("readAlerts", readAlerts(input)),
					anomalies: part("readAnomalies", readAnomalies(input)),
					investigations: part("readInvestigations", readInvestigations(input)),
					errorIssues: part("readErrorIssues", readErrorIssues(input)),
					agentFeedback: part("readAgentFeedback", readAgentFeedback(input)),
					priorCancellations: part("readPriorCancellations", readPriorCancellations(input)),
					scrapeTargets: part("readScrapeTargets", readScrapeTargets(input)),
					apiKeys: part("readApiKeys", readApiKeys(input)),
					digest: part("readDigest", readDigest(input)),
				},
				// The invocation's pool holds a few connections; leave some to the rest of the review.
				{ concurrency: 3 },
			)
		})

		return { read }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(IntegrationInventoryService.layer),
	)
}
