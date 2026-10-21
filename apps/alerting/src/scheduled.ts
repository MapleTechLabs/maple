/**
 * The alerting ticks and their cron routing, kept apart from the Worker shell
 * (`./worker.ts`) so the schedule and its concurrency groups can be
 * characterized without acquiring production drivers — and so the api layer
 * graph this file drags in is imported on the first fire, not at startup and
 * not in the deploy process, where the Worker's init also runs.
 */
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { AnomalyDetectionService } from "@maple/backend/services/alerts/AnomalyDetectionService"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { DigestService } from "@maple/backend/services/digest/DigestService"
import { WebAnalyticsDigestService } from "@maple/backend/services/digest/WebAnalyticsDigestService"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import { EscalationService } from "@maple/backend/services/alerts/EscalationService"
import { FixVerificationTickService } from "@maple/backend/services/errors/FixVerificationTickService"
import { GcpMetricsService } from "@maple/backend/services/integrations/GcpMetricsService"
import { IncidentClassifier } from "@maple/backend/services/errors/IncidentClassifier"
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { PullRequestLookupLive } from "@maple/backend/services/errors/pull-request-lookup-live"
import { PlanetScaleService } from "@maple/backend/services/integrations/PlanetScaleService"
import { PrReviewPostMergeService } from "@maple/backend/services/pr-review/PrReviewPostMergeService"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { ServiceMapRollupService } from "@maple/backend/services/dashboards/ServiceMapRollupService"
import { layerMapleDbConnection } from "@maple/backend/platform/pg-connection-source"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { EmailSender, type EmailSenderClient } from "@maple/backend/platform/bindings"
import { type ChatSessionNamespace, chatSessionsLayerIfBound } from "@maple/backend/platform/chat-sessions"
import { envPorts } from "@maple/backend/platform/env-ports"
import { Cause, Effect, Layer, Match, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { isLaneOf, scheduleFor, type TickLane } from "./schedule.ts"
import type { AlertingWorkerEnv } from "./worker.ts"

/**
 * The tick graph for one fire. Deliberately without a tracer or logger of its
 * own: those come from the SDK the Worker bridge builds into each fire's
 * scope (`WorkerTelemetry` on the shell's init), and a layer here that
 * provided either would shadow them — `worker-telemetry.test.ts` pins that
 * a tick's spans still reach the export.
 */
export const layerTick = (
	env: AlertingWorkerEnv,
	email: Option.Option<EmailSenderClient> = Option.none(),
	chatSessions?: ChatSessionNamespace,
) =>
	Layer.mergeAll(
		AlertsService.layer,
		AnomalyDetectionService.layer,
		CloudflareAnalyticsService.layer,
		GcpMetricsService.layer,
		PlanetScaleService.layer,
		RailwayMetricsService.layer,
		SupabaseConnectionService.layer,
		DigestService.layer,
		WebAnalyticsDigestService.layer,
		ErrorsService.layer,
		FixVerificationTickService.layer,
		EscalationService.layer,
		ServiceMapRollupService.layer,
		PrReviewPostMergeService.layer,
		// Read by `maybeEnqueueTriage` when present; its absence means every
		// incident opened here is investigated unclassified.
		IncidentClassifier.layer,
	).pipe(
		Layer.provide(PullRequestLookupLive),
		Layer.provide(Layer.mergeAll(Env.layer, DatabasePgLive, EdgeCacheServiceLive, FetchHttpClient.layer)),
		Layer.provideMerge(
			Layer.mergeAll(
				layerMapleDbConnection(env),
				envPorts(env),
				chatSessionsLayerIfBound(chatSessions, env),
				Layer.succeed(EmailSender, email),
			),
		),
	)

/**
 * Standard tick failure isolation. A broken tick must not fail the whole scheduled
 * invocation (several ticks share one cron dispatch), so genuine failures are logged and
 * swallowed — but interrupt-only causes (isolate teardown) are re-raised so the shell can
 * treat them as a cancelled fire instead of logging a phantom tick failure. Mirrors the
 * per-org guards inside the tick services.
 */
export const catchTickFailure = (label: string) =>
	Effect.catchCause((cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.logError("Alerting tick failed").pipe(
					Effect.annotateLogs({
						"error.message": summarizeCause(cause),
						"maple.alerting.tick": label,
					}),
				),
	)

interface TickAnnotations {
	readonly [key: string]: unknown
}

const makeTick = <A, E, R>(
	run: Effect.Effect<A, E, R>,
	spanKey: string,
	annotationsFor: (result: A) => TickAnnotations | undefined,
): Effect.Effect<void, never, R> =>
	run.pipe(
		Effect.tap((result) => {
			const annotations = annotationsFor(result)
			const namespacedAnnotations =
				annotations === undefined
					? undefined
					: Object.fromEntries(
							Object.entries(annotations).map(([key, value]) => [
								`maple.alerting.${key}`,
								value,
							]),
						)
			return namespacedAnnotations === undefined
				? Effect.void
				: Effect.logInfo("Alerting tick completed").pipe(
						Effect.annotateLogs({ ...namespacedAnnotations, "maple.alerting.tick": spanKey }),
					)
		}),
		Effect.asVoid,
		Effect.withSpan(`alerting.${spanKey}_tick`),
		catchTickFailure(spanKey),
	)

const alertTick = makeTick(
	AlertsService.use((alerts) => alerts.runSchedulerTick()),
	"scheduler",
	(result) => ({
		evaluatedCount: result.evaluatedCount,
		processedCount: result.processedCount,
		evaluationFailureCount: result.evaluationFailureCount,
		warehouseUnavailableSkipCount: result.warehouseUnavailableSkipCount,
		deferredCount: result.deferredCount,
		deliveryFailureCount: result.deliveryFailureCount,
	}),
)

const errorTick = makeTick(
	ErrorsService.use((errors) => errors.runTick()),
	"error",
	(result) => ({
		orgsProcessed: result.orgsProcessed,
		issuesTouched: result.issuesTouched,
		incidentsOpened: result.incidentsOpened,
		incidentsResolved: result.incidentsResolved,
		issuesReopened: result.issuesReopened,
		issuesArchived: result.issuesArchived,
		issuesDeleted: result.issuesDeleted,
		retentionRan: result.retentionRan,
		investigationsAbandoned: result.investigationsAbandoned,
	}),
)

const fixVerificationTick = makeTick(
	FixVerificationTickService.use((service) => service.runTick()),
	"fix_verification",
	(result) => ({
		examined: result.examined,
		refuted: result.refuted,
		investigationsStarted: result.investigationsStarted,
		verdictsApplied: result.verdictsApplied,
		skipped: result.skipped,
		failedRows: result.failedRows,
	}),
)

const escalationTick = makeTick(
	EscalationService.use((escalations) => escalations.runEscalationTick()),
	"escalation",
	(result) =>
		result.processed > 0
			? {
					processed: result.processed,
					sent: result.sent,
					skipped: result.skipped,
					failed: result.failed,
					retried: result.retried,
				}
			: undefined,
)

const opsDigestTick = makeTick(
	DigestService.use((digest) => digest.runDigestTick()),
	"digest",
	(result) => ({
		sentCount: result.sentCount,
		errorCount: result.errorCount,
		skipped: result.skipped,
	}),
)

const webAnalyticsDigestTick = makeTick(
	WebAnalyticsDigestService.use((digest) => digest.runTick()),
	"web_analytics_digest",
	(result) => ({
		sentCount: result.sentCount,
		errorCount: result.errorCount,
		skipped: result.skipped,
	}),
)

// Sequential: the ops digest tick runs the daily Clerk member sweep that seeds
// the subscriber rows both emails read.
const digestTick = Effect.andThen(opsDigestTick, webAnalyticsDigestTick)

// The onboarding drip moved to maple-portal (`camp_onboarding`), which owns the
// sequence, its send log and its suppression list. `org_onboarding_state` stays
// here — the in-app checklist still uses the rest of that table — and so do its
// four `*_email_sent_at` columns, which are what the portal's backfill reads.

const serviceMapRollupTick = makeTick(
	ServiceMapRollupService.use((rollup) => rollup.runRollupTick()),
	"service_map_rollup",
	(result) => ({
		orgsProcessed: result.orgsProcessed,
		hoursRolledUp: result.hoursRolledUp,
		edgesWritten: result.edgesWritten,
		resolutionsWritten: result.resolutionsWritten,
		resolutionHoursChecked: result.resolutionHoursChecked,
		emptyResolutionHours: result.emptyResolutionHours,
		orgFailures: result.orgFailures,
	}),
)

const anomalyTick = makeTick(
	AnomalyDetectionService.use((anomalies) => anomalies.runTick()),
	"anomaly",
	(result) => ({
		orgsProcessed: result.orgsProcessed,
		seriesEvaluated: result.seriesEvaluated,
		incidentsOpened: result.incidentsOpened,
		incidentsAttached: result.incidentsAttached,
		incidentsReopened: result.incidentsReopened,
		incidentsContinued: result.incidentsContinued,
		incidentsResolved: result.incidentsResolved,
		orgFailures: result.orgFailures,
	}),
)

const cloudflareAnalyticsTick = makeTick(
	CloudflareAnalyticsService.use((analytics) => analytics.pollAllOrgs()),
	"cloudflare_analytics",
	(result) => ({
		orgs: result.orgs,
		rowsIngested: result.rowsIngested,
		skipped: result.skipped,
		failures: result.failures,
		perOrg: result.perOrg,
	}),
)

const gcpMetricsTick = makeTick(
	GcpMetricsService.use((gcp) => gcp.pollAll()),
	"gcp_metrics",
	(result) =>
		result.polled + result.deferred > 0
			? {
					polled: result.polled,
					deferred: result.deferred,
					rowsIngested: result.rowsIngested,
					failures: result.failures,
					incompleteMetrics: result.incompleteMetrics,
					calls: result.calls,
				}
			: undefined,
)

const planetScaleTick = makeTick(
	PlanetScaleService.use((planetscale) => planetscale.pollAllOrgs()),
	"planetscale",
	(result) =>
		result.orgs > 0
			? {
					orgs: result.orgs,
					refreshed: result.refreshed,
					skipped: result.skipped,
					failures: result.failures,
					deployEvents: result.deployEvents,
				}
			: undefined,
)

const railwayMetricsTick = makeTick(
	RailwayMetricsService.use((railway) => railway.pollAllOrgs()),
	"railway_metrics",
	(result) =>
		result.orgs > 0
			? {
					orgs: result.orgs,
					rowsIngested: result.rowsIngested,
					skipped: result.skipped,
					failures: result.failures,
				}
			: undefined,
)

const supabaseDiscoveryTick = makeTick(
	SupabaseConnectionService.use((supabase) => supabase.discoverAllOrgs()),
	"supabase_discovery",
	(result) =>
		result.orgs > 0
			? {
					orgs: result.orgs,
					discovered: result.discovered,
					skipped: result.skipped,
					failures: result.failures,
				}
			: undefined,
)

const prReviewPostMergeTick = makeTick(
	PrReviewPostMergeService.use((service) => service.runTick()),
	"pr_review_post_merge",
	(result) =>
		result.examined > 0
			? {
					examined: result.examined,
					reported: result.reported,
					waiting: result.waiting,
					gaveUp: result.gaveUp,
					failedRows: result.failedRows,
				}
			: undefined,
)

export interface ScheduledTickPrograms<R = never> {
	readonly alert: Effect.Effect<void, never, R>
	readonly anomaly: Effect.Effect<void, never, R>
	readonly cloudflareAnalytics: Effect.Effect<void, never, R>
	readonly digest: Effect.Effect<void, never, R>
	readonly error: Effect.Effect<void, never, R>
	readonly escalation: Effect.Effect<void, never, R>
	readonly fixVerification: Effect.Effect<void, never, R>
	readonly gcpMetrics: Effect.Effect<void, never, R>
	readonly planetScale: Effect.Effect<void, never, R>
	readonly prReviewPostMerge: Effect.Effect<void, never, R>
	readonly railwayMetrics: Effect.Effect<void, never, R>
	readonly serviceMapRollup: Effect.Effect<void, never, R>
	readonly supabaseDiscovery: Effect.Effect<void, never, R>
}

/** The program each lane runs; every tick belongs to exactly one lane. */
const laneProgram = <R>(lane: TickLane, ticks: ScheduledTickPrograms<R>): Effect.Effect<void, never, R> =>
	Match.value(lane).pipe(
		Match.when("alert", () => ticks.alert),
		// `fixVerification` is chained onto `error` rather than given its own lane:
		// a window this minute's error tick just refuted must already be settled
		// when the verification tick looks at it.
		Match.when("error", () => Effect.andThen(ticks.error, ticks.fixVerification)),
		Match.when("escalation", () => ticks.escalation),
		Match.when("anomaly", () => ticks.anomaly),
		Match.when("cloudflare_analytics", () => ticks.cloudflareAnalytics),
		Match.when("gcp_metrics", () => ticks.gcpMetrics),
		Match.when("planetscale", () => ticks.planetScale),
		Match.when("railway_metrics", () => ticks.railwayMetrics),
		Match.when("pr_review_post_merge", () => ticks.prReviewPostMerge),
		Match.when("digest", () => ticks.digest),
		Match.when("service_map_rollup", () => ticks.serviceMapRollup),
		Match.when("supabase_discovery", () => ticks.supabaseDiscovery),
		Match.exhaustive,
	)

/**
 * One lane of `cron`, bounded by the cron's deadline. Kept apart from the
 * Worker shell so routing and the deadline can be characterized without
 * production drivers.
 */
export const selectLaneProgram = <R>(
	cron: string,
	lane: string,
	ticks: ScheduledTickPrograms<R>,
): Effect.Effect<void, never, R> => {
	const schedule = scheduleFor(cron)
	// Fail closed: an unknown cron or lane must not run anything.
	if (schedule === undefined || !isLaneOf(cron, lane)) {
		return Effect.logWarning("Skipping unknown alerting cron lane").pipe(
			Effect.annotateLogs({ cron, lane }),
		)
	}
	return laneProgram(lane, ticks).pipe(
		Effect.timeoutOrElse({
			duration: schedule.deadline,
			orElse: () =>
				Effect.logError("Alerting lane exceeded its deadline and was interrupted").pipe(
					Effect.annotateLogs({
						"maple.alerting.cron": cron,
						"maple.alerting.lane": lane,
						"maple.alerting.deadline": schedule.deadline,
					}),
				),
		}),
	)
}

type ScheduledServices =
	| AlertsService
	| AnomalyDetectionService
	| CloudflareAnalyticsService
	| DigestService
	| WebAnalyticsDigestService
	| ErrorsService
	| EscalationService
	| FixVerificationTickService
	| GcpMetricsService
	| PlanetScaleService
	| PrReviewPostMergeService
	| RailwayMetricsService
	| ServiceMapRollupService
	| SupabaseConnectionService

export const scheduledTicks: ScheduledTickPrograms<ScheduledServices> = {
	alert: alertTick,
	anomaly: anomalyTick,
	cloudflareAnalytics: cloudflareAnalyticsTick,
	digest: digestTick,
	error: errorTick,
	escalation: escalationTick,
	fixVerification: fixVerificationTick,
	gcpMetrics: gcpMetricsTick,
	planetScale: planetScaleTick,
	prReviewPostMerge: prReviewPostMergeTick,
	railwayMetrics: railwayMetricsTick,
	serviceMapRollup: serviceMapRollupTick,
	supabaseDiscovery: supabaseDiscoveryTick,
}

/**
 * One lane of a cron fire, over the layer graph built from this invocation's
 * env and released when the lane completes. Each lane has its own Postgres
 * pool: lanes used to share one per fire, so one stalled statement held every
 * tick in it (alert, error and escalation together) for as long as it hung.
 * The deadline sits inside the scope, so an interrupted lane's pool is closed.
 */
export const runScheduled = (
	cron: string,
	lane: string,
	env: AlertingWorkerEnv,
	email: Option.Option<EmailSenderClient>,
	chatSessions: ChatSessionNamespace,
): Effect.Effect<void, unknown> =>
	withPgConnectionScope(selectLaneProgram(cron, lane, scheduledTicks)).pipe(
		// One lane is one application run: the layer is built here and released
		// with it, as the async entry's ManagedRuntime was.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(layerTick(env, email, chatSessions)),
	)
