import {
	alertDeliveryRetryDelayMs,
	canRetryAlertDelivery,
	evaluateAlertObservation,
	highestBreachedLevel,
	interleaveAlertRulesByTenant,
	makeAlertDeliveryKey,
	maxSeverity,
	nearestSeverity,
	planAlertLifecycle,
	type AlertLifecycleInput,
} from "@maple/alerting-core"
import {
	alertIntervalsFitting,
	alertQueryLimits,
	alertRuleIntervalMinutes,
	nextSlowerAlertInterval,
	ENGINE_UNGROUPED_GROUP_KEY,
	formatWarehouseDateTime,
	isAlertRuleDue,
	snapAlertWindowEndMs,
	warehouseDateTime64,
	parseWarehouseDateTime,
} from "@maple/query-engine"
import {
	AlertComparator as AlertComparatorSchema,
	type AlertEvaluationErrorKind,
	AlertDeliveryAuthError,
	AlertDeliveryError,
	type AlertDeliveryFailure,
	AlertDeliveryRejectedError,
	AlertDeliveryTargetMissingError,
	AlertDestinationDecryptionError,
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertDestinationStoredConfigInvalidError,
	AlertEvaluationResult,
	AlertEventType as AlertEventTypeSchema,
	AlertForbiddenError,
	AlertIncidentDocument,
	AlertIncidentHoldReason,
	AlertIncidentStatus,
	type AlertDestinationNotFoundError,
	type AlertRuleDestinationNotFoundError,
	type AlertRuleNotFoundError,
	type AlertRuleStoredConfigInvalidError,
	AlertPersistenceError,
	AlertRuleDocument,
	AlertRulePreviewFiringSpan,
	AlertRulePreviewPoint,
	AlertRulePreviewResponse,
	AlertRulePreviewSeries,
	AlertQueryTiming,
	type AlertRulePreviewRequest,
	AlertSeverity as AlertSeveritySchema,
	type AlertSeverity,
	AlertSignalType as AlertSignalTypeSchema,
	AlertValidationError,
	AlertNotificationTemplate,
	type AlertEventType as AlertEventTypeValue,
	type AlertRuleUpsertRequest,
	type AlertGroupBy,
	UNGROUPED_GROUP_KEY,
	OrgId,
	AlertRuleId,
	type AlertDestinationId,
	type AlertIncidentId,
	type WarehouseQueryPathError,
	QueryEngineTimeoutError,
	type QueryEngineValidationError,
	RoleName,
	WarehouseUpstreamError,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as Orm from "@maple-dev/effect-orm/database"
import {
	AlertDeliveryEvents,
	type AlertDeliveryEventRow,
	AlertDestinations,
	type AlertDestinationRow,
	AlertIncidents,
	type AlertIncidentRow,
	AlertRuleClaims,
	AlertRules,
	AlertRuleStates,
	type AlertRuleStateRow,
} from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import {
	Array as Arr,
	Cause,
	Chunk,
	Duration,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Match,
	Metric,
	MutableHashMap,
	Option,
	Order,
	Random,
	Record,
	Result,
	Redacted,
	Ref,
	Schema,
	Semaphore,
	Stream,
	Context,
} from "effect"
import { HttpClient } from "effect/http"
import * as AlertingMetrics from "@maple/backend/observability/AlertingMetrics"
import { escalateAlertIssue, upsertAlertIssue } from "@maple/backend/services/errors/issue-hub"
import { msToSqlTimestamp } from "@maple/backend/platform/time"
import {
	maybeEnqueueTriage,
	type MaybeEnqueueTriageInput,
} from "@maple/backend/services/errors/ai-triage-enqueue"
import { forkRequestScoped } from "@maple/backend/platform/fork-request-scoped"
import {
	holdCeilingMs,
	type LivenessReason,
	type LivenessVerdict,
	probeLiveness,
} from "@maple/backend/services/alerts/telemetry-liveness"
import { simulateFiringSpans } from "./alert-firing-spans"
import {
	evaluationErrorKind,
	isQueryLimitFailure,
	SLOWDOWN_AFTER_LIMIT_FAILURES,
} from "./alert-evaluation-errors"
import { ChatSessions } from "@maple/backend/platform/bindings"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { formatComparator } from "./alert-formatting"
import { ruleAtSeverity } from "./alert-thresholds"
import { buildChatDigestBlocks, CHAT_DIGEST_THRESHOLD, type ChatDigestItem } from "./delivery/chat-digest"
import { makeIncidentPushBudget, type IncidentPushBudget } from "./alert-push-budget"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { makePersistenceError } from "./alert-persistence"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { withAlertEvaluationScope, type GroupedAlertObservation } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { chartImageUrl, chartWindow, loadChartSeries } from "./alert-chart-series"
import { systemTenant } from "./system-tenant"
import type { AlertChecksRow } from "@maple/domain/tinybird"
import { ChatAlertPoster } from "./ChatAlertPoster"
import { LinearIssueTracker } from "./LinearIssueTracker"

import { MobilePushService, type ResolvedAfterHold } from "@maple/backend/services/push/MobilePushService"
import { AlertRuntime } from "./AlertRuntime"
import { AlertDestinationsService, type AlertDestinationsServiceApi } from "./AlertDestinationsService"
import { makeAlertDestinationDelivery, parseAlertDestinationEncryptionKey } from "./AlertDestinationDelivery"
import { AlertReadModelsService, type AlertReadModelsServiceApi } from "./AlertReadModelsService"
import { AlertRulesService, makeAlertRulePersistence, type AlertRulesServiceApi } from "./AlertRulesService"
import { UptimeAlertSource } from "@maple/backend/services/uptime/UptimeAlertSource"
import {
	openForAlertIncident,
	resolveForAlertIncident,
} from "@maple/backend/services/status-pages/auto-incidents"
import {
	decodeStoredAlertRuleMetadata,
	storedRuleCondition,
	isGroupedPlan,
	toStorageGroupKey,
	makeAlertValidationError as makeValidationError,
	perServiceRules,
	planEvaluateSource,
	alertSchedulerLaneOf,
	type AlertSchedulerLane,
	selectStoredAlertRules,
	type NormalizedRule,
	type StoredAlertRuleRow,
	UPTIME_RULE_MANAGED_MESSAGE,
} from "./AlertRuleModel"
import { mapSignalUnit, resolveSignalDisplay } from "./alert-signal-display"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

export { AlertRuntime, type AlertRuntimeApi } from "./AlertRuntime"
export type { AlertSchedulerLane } from "./AlertRuleModel"

type EvaluatedRule = import("@maple/alerting-core").AlertEvaluation

/**
 * A tick's claim on a rule expired and another tick re-claimed it before this
 * one finished writing. The rule's remaining writes and notifications belong to
 * the new claimant, so this tick stops processing the rule.
 */
class AlertRuleClaimLostError extends Schema.TaggedError<AlertRuleClaimLostError>()(
	"@maple/alerts/AlertRuleClaimLostError",
	{
		message: Schema.String,
		ruleId: AlertRuleId,
		claimedAt: Schema.Number,
		currentClaimAt: Schema.NullOr(Schema.Number),
	},
) {}

/**
 * The claim a tick holds on a rule: its `alert_rule_claims.last_scheduled_at`,
 * plus the `alert_rules.updated_at` of the config the tick is evaluating.
 */
interface RuleClaim {
	readonly ruleId: AlertRuleId
	readonly claimedAt: number
	readonly ruleUpdatedAt: number
}

/** One delivery row an incident event will queue, built before the write that queues it. */
interface PreparedIncidentDelivery {
	readonly orgId: OrgId
	readonly incidentId: AlertIncidentId
	readonly ruleId: AlertRuleId
	readonly destinationId: AlertDestinationId
	readonly eventType: AlertEventTypeValue
	readonly payload: Record<string, unknown>
	readonly scheduledAt: number
}

/**
 * One rule's state rows that need no other write this tick, keyed by group,
 * and the check rows reporting them, held back until those rows commit.
 */
interface RuleStateBuffer {
	readonly rows: HashMap.HashMap<string, AlertRuleStateRow>
	readonly checks: Chunk.Chunk<AlertChecksRow>
}
type RuleStateWrites = Ref.Ref<RuleStateBuffer>

const emptyRuleStateBuffer: RuleStateBuffer = { rows: HashMap.empty(), checks: Chunk.empty() }

const FenceResultRow = Schema.Struct({ fenced: Schema.Number })

type AlertDestinationStorageError = AlertDestinationDecryptionError | AlertDestinationStoredConfigInvalidError

interface DeliveryAttemptFailure {
	readonly message: string
	readonly kind: string
	readonly retryable: boolean
}

/** What the liveness gate decided for an incident whose breach stopped appearing. */
type LivenessGateDecision =
	| {
			readonly kind: "resolve"
			/** Overrides the caller's resolve reason when the incident was held first. */
			readonly reason: string | null
			readonly heldForMs: number
	  }
	| {
			readonly kind: "hold"
			readonly reason: Exclude<LivenessReason, "ok" | "no_baseline">
			readonly heldSinceMs: number
			readonly ceilingMs: number | null
	  }

/** The hold a resolve is ending, or null when the incident was never held. */
const afterHold = (
	incident: Pick<AlertIncidentRow, "holdReason">,
	heldForMs: number,
): ResolvedAfterHold | null =>
	incident.holdReason === null
		? null
		: { reason: decodeAlertIncidentHoldReasonSync(incident.holdReason), heldForMs }

const decodeAlertSeverityOption = Schema.decodeUnknownOption(AlertSeveritySchema)

/**
 * The tier fields a delivery dispatches with. The rule's tiers come from the
 * queued event when it carries them, so the key an event pages under cannot
 * change between queueing and a retry; older payloads fall back to the rule as
 * it is now. The peak is the higher of the event's and the incident's, so an
 * alert opened later still closes.
 */
const dispatchTierFields = (
	queuedSeverities: ReadonlyArray<string> | undefined,
	queuedPeak: string | null,
	incidentPeak: string | null,
	currentRule: Option.Option<{ readonly thresholds: ReadonlyArray<{ readonly severity: AlertSeverity }> }>,
) => {
	const ruleSeverities =
		queuedSeverities === undefined
			? Option.map(currentRule, (condition) => condition.thresholds.map((tier) => tier.severity))
			: Option.some(
					queuedSeverities.flatMap((severity) =>
						Option.toArray(decodeAlertSeverityOption(severity)),
					),
				)
	const peak = maxSeverity(
		Option.getOrNull(decodeAlertSeverityOption(queuedPeak)),
		Option.getOrNull(decodeAlertSeverityOption(incidentPeak)),
	)
	return {
		...Option.match(ruleSeverities, {
			onNone: () => undefined,
			onSome: (value) => ({ ruleSeverities: value }),
		}),
		...(peak === null ? undefined : { incidentPeakSeverity: peak }),
	}
}

/** The rule as an incident's resolve sees it: its tier (or the one the rule kept), up to its peak. */
const ruleForResolve = (
	rule: NormalizedRule,
	incident: Pick<AlertIncidentRow, "severity" | "peakSeverity">,
) =>
	ruleAtSeverity(
		rule,
		nearestSeverity(
			decodeAlertSeveritySync(incident.severity),
			rule.thresholds.map((tier) => tier.severity),
		),
		incident.peakSeverity === null ? null : decodeAlertSeveritySync(incident.peakSeverity),
	)

const describeHold = (reason: Exclude<LivenessReason, "ok" | "no_baseline">): string => {
	switch (reason) {
		case "volume_collapsed":
			return "reduced"
		case "no_data":
			return "absent"
		case "sampling_changed":
			return "resampled"
		case "probe_failed":
			return "unverifiable"
	}
}
/**
 * Consecutive *terminal* delivery failures after which a destination is
 * auto-disabled.
 *
 * A `retry: "never"` failure is already not retried within its own delivery —
 * but that only bounds one incident. Nothing used to bound the destination, so
 * a webhook whose provider answers 400 forever kept being handed every new
 * incident, failing, and losing the alert silently. Three in a row is enough to
 * separate "this one payload was refused" from "this destination is dead".
 */
const DESTINATION_DISABLE_AFTER_FAILURES = 3
/** Bound on the stored `disabled_reason`; it is a provider sentence, not a log. */
const DISABLED_REASON_MAX_LENGTH = 500
const ALERT_TEST_DELIVERY_CONCURRENCY = 5
// A Worker invocation has six outbound slots. The delivery drain runs beside these POSTs
// with three and Postgres needs one, so a stalled insert never makes a page wait for a slot.
const ALERT_CHECK_INGEST_CONCURRENCY = 2
// A healthy alert_checks POST is under a second; a stalled one is dropped, never retried,
// because a write the warehouse already accepted would be counted twice.
const ALERT_CHECK_INGEST_TIMEOUT = Duration.seconds(5)
// Caps the whole ingest so a warehouse-wide stall across many orgs still ends the tick early.
const ALERT_CHECK_INGEST_BUDGET = Duration.seconds(15)

/** A warehouse outage (5xx or unreachable), not a fault of the rule being evaluated. */
const warehouseOutageOf = (error: unknown): Option.Option<WarehouseUpstreamError> =>
	error instanceof WarehouseUpstreamError &&
	(error.upstreamStatus === undefined || error.upstreamStatus >= 500)
		? Option.some(error)
		: Option.none()

// Storm fuse: cap issue-hub upserts per scheduler tick so a pathological
// group-by rule opening hundreds of incidents can't stall the per-minute tick.
const ISSUE_UPSERTS_PER_TICK = 50
// Investigation starts in flight at once after the rule loop. Each is a model call
// plus an agent start (1-3 s); 50 at 8 wide take about 10 s instead of 60.
const TRIAGE_START_CONCURRENCY = 8
// The same fuse for phones lives in `alert-push-budget.ts`, which bounds both
// the tick's total sends and any one rule's share of them. Deliberately not
// solved by forking the sends instead: on Workers a fiber that outlives the
// invocation is simply cancelled, which would trade a slow notification for a
// silently dropped one.
/**
 * Checks read for the Lock Screen sparkline. Rules evaluate about once a
 * minute, so this is the last ~half hour — enough to show the climb that opened
 * the incident, before the server downsamples it to twelve points.
 */
const LIVE_ACTIVITY_CHECK_HISTORY = 30
const DELIVERY_LEASE_TTL_MS = 30_000

/* -------------------------------------------------------------------------- */
/*  Schemas for stored JSON formats                                           */
/* -------------------------------------------------------------------------- */

const StoredDeliveryPayloadSchema = Schema.StructWithRest(
	Schema.Struct({
		event: Schema.optionalKey(Schema.Unknown),
		eventType: Schema.optionalKey(Schema.String),
		incidentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
		incidentStatus: Schema.optionalKey(Schema.String),
		dedupeKey: Schema.optionalKey(Schema.String),
		rule: Schema.optionalKey(
			Schema.Struct({
				id: Schema.optionalKey(Schema.String),
				name: Schema.optionalKey(Schema.String),
				signalType: Schema.optionalKey(Schema.String),
				severity: Schema.optionalKey(Schema.String),
				groupKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
				comparator: Schema.optionalKey(Schema.String),
				threshold: Schema.optionalKey(Schema.Number),
				thresholdUpper: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				windowMinutes: Schema.optionalKey(Schema.Number),
				severities: Schema.optionalKey(Schema.Array(Schema.String)),
			}),
		),
		peakSeverity: Schema.optionalKey(Schema.NullOr(Schema.String)),
		observed: Schema.optionalKey(
			Schema.Struct({
				value: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				sampleCount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
		template: Schema.optionalKey(Schema.NullOr(AlertNotificationTemplate)),
		chart: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({
					sparkline: Schema.optionalKey(Schema.String),
					url: Schema.optionalKey(Schema.String),
				}),
			),
		),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
)

const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeAlertIncidentIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const decodeAlertDeliveryEventIdSync = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeAlertSeveritySync = Schema.decodeUnknownSync(AlertSeveritySchema)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeAlertIncidentStatusSync = Schema.decodeUnknownSync(AlertIncidentStatus)
const decodeAlertIncidentHoldReasonSync = Schema.decodeUnknownSync(AlertIncidentHoldReason)
const decodeAlertEventTypeSync = Schema.decodeUnknownSync(AlertEventTypeSchema)

const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)

const isServiceGroupBy = (groupBy: AlertGroupBy | null): boolean =>
	groupBy != null && groupBy.length === 1 && groupBy[0] === "service.name"

const resolveServiceLinkName = (
	rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
	groupKey: string | null,
): string | null => {
	if (rule.serviceNames.length === 1) return rule.serviceNames[0] ?? null
	if (groupKey != null && groupKey !== UNGROUPED_GROUP_KEY && isServiceGroupBy(rule.groupBy)) {
		return groupKey
	}
	return null
}
/**
 * Cap on how many evaluation windows a rule preview replays.
 *
 * One bucket is one evaluation window, so the cap is what decides whether the
 * preview covers the range the user picked. At 200 it did not: the create
 * form's default (5-minute window, last 24h) needs 288 and the 1-minute window
 * needs 1440, so the common case silently charted only the newest slice of a
 * full-width axis. 1500 covers every window/range pair the pickers can produce
 * up to 24h, plus the coarser windows over 7d and 30d, and still bounds the
 * response for the pathological combinations (1-minute windows over 30 days),
 * which clamp and say so via `truncatedToStart`.
 */
const MAX_PREVIEW_BUCKETS = 1500

/** Preserve each org's oldest-first order while preventing one org from monopolizing a tick. */
export const interleaveAlertRulesByOrg = <T extends { readonly orgId: string }>(
	rows: ReadonlyArray<T>,
): ReadonlyArray<T> => interleaveAlertRulesByTenant(rows, (row) => row.orgId)

// Least recently claimed first (never claimed sorts first), so the rules a tick
// deferred lead the next one instead of staying in the tail. The sort is stable.
const orderAlertRulesByLastClaim = <T extends { readonly id: string }>(
	rows: ReadonlyArray<T>,
	lastClaimedAt: ReadonlyMap<string, number>,
): ReadonlyArray<T> =>
	Arr.sort(
		rows,
		Order.mapInput(Order.Number, (row: T) => lastClaimedAt.get(row.id) ?? 0),
	)

/** The destination's provider refused the delivery, as opposed to Maple failing to send it. */
const isProviderDeliveryFailure = (error: unknown): error is AlertDeliveryFailure =>
	error instanceof AlertDeliveryError ||
	error instanceof AlertDeliveryAuthError ||
	error instanceof AlertDeliveryTargetMissingError ||
	error instanceof AlertDeliveryRejectedError

// Deliveries claimed per batch. The drain takes batches until the queue is
// empty or DELIVERY_DRAIN_BUDGET_MS has passed; the rest wait for the next tick.
const DELIVERY_DRAIN_LIMIT = 50
const DELIVERY_DRAIN_BUDGET_MS = 20_000
// Destinations drained at once. Small: each in-flight delivery holds one of the
// invocation's outbound connections, which the Postgres pool also draws on.
const DELIVERY_DESTINATION_CONCURRENCY = 3

// Logs and drops a typed failure or a defect, so one rule, chunk or delivery
// cannot end the tick. Interruption still propagates.
const isolate =
	(message: string, annotations: Record<string, unknown>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> => {
		const log = (cause: Cause.Cause<unknown>) =>
			Effect.logError(message).pipe(
				Effect.annotateLogs({ ...annotations, cause: summarizeCause(cause) }),
			)
		return self.pipe(
			Effect.asVoid,
			Effect.catch((error) => log(Cause.fail(error))),
			Effect.catchDefect((defect) => log(Cause.die(defect))),
		)
	}

const toIngestDateTime64 = warehouseDateTime64

type StoredDeliveryPayloadType = Schema.Schema.Type<typeof StoredDeliveryPayloadSchema>

const parseDeliveryPayload = (
	value: unknown,
): Effect.Effect<StoredDeliveryPayloadType, AlertValidationError> =>
	Schema.decodeUnknownEffect(StoredDeliveryPayloadSchema)(value).pipe(
		Effect.mapError((cause) => makeValidationError("Stored delivery payload is invalid", [], cause)),
	)

// Formatting helpers imported from AlertDeliveryDispatch

export interface AlertsServiceApi
	extends AlertDestinationsServiceApi, AlertReadModelsServiceApi, AlertRulesServiceApi {
	readonly updateRule: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
		request: AlertRuleUpsertRequest,
	) => Effect.Effect<
		AlertRuleDocument,
		| AlertForbiddenError
		| AlertValidationError
		| AlertPersistenceError
		| AlertRuleNotFoundError
		| AlertRuleDestinationNotFoundError
		| AlertRuleStoredConfigInvalidError
	>
	readonly testRule: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertRuleUpsertRequest,
		sendNotification?: boolean,
	) => Effect.Effect<
		AlertEvaluationResult,
		| AlertForbiddenError
		| AlertValidationError
		| AlertPersistenceError
		| AlertRuleDestinationNotFoundError
		| AlertDeliveryFailure
		| AlertDestinationStorageError
		| QueryEngineValidationError
		| QueryEngineTimeoutError
		| WarehouseQueryPathError
	>
	/**
	 * `roles` gates raw-SQL previews only: preview itself needs just `alerts:read`,
	 * but replaying a raw_query rule executes user-authored ClickHouse, which is
	 * the org-admin capability `createRule`/`testRule` already require.
	 */
	readonly previewRule: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		request: AlertRulePreviewRequest,
	) => Effect.Effect<
		AlertRulePreviewResponse,
		| AlertValidationError
		| AlertForbiddenError
		| QueryEngineValidationError
		| QueryEngineTimeoutError
		| WarehouseQueryPathError
	>
	readonly runSchedulerTick: (lane?: AlertSchedulerLane) => Effect.Effect<
		{
			readonly evaluatedCount: number
			readonly processedCount: number
			readonly evaluationFailureCount: number
			readonly warehouseUnavailableSkipCount: number
			readonly deferredCount: number
			readonly deliveryFailureCount: number
			readonly alertChecksDroppedCount: number
		},
		| AlertPersistenceError
		| AlertDeliveryFailure
		| AlertValidationError
		| AlertRuleNotFoundError
		| AlertDestinationNotFoundError
		| AlertRuleStoredConfigInvalidError
		// Note: warehouse tagged errors flow up from evaluateRule but are caught
		// inside the per-rule Effect.catch in the scheduler tick, so the tick
		// itself never surfaces them.
	>
}

export class AlertsService extends Context.Service<AlertsService, AlertsServiceApi>()(
	"@maple/backend/services/AlertsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const destinations = yield* AlertDestinationsService
			const readModels = yield* AlertReadModelsService
			const rules = yield* AlertRulesService
			const queryEngine = yield* QueryEngineService
			const warehouse = yield* WarehouseQueryService
			const runtime = yield* AlertRuntime
			const uptimeAlerts = yield* UptimeAlertSource
			const httpClient = yield* HttpClient.HttpClient
			const email = yield* EmailService
			const orgChSettings = yield* OrgClickHouseSettingsService
			const chatAlertPoster = yield* ChatAlertPoster
			const mobilePush = yield* MobilePushService
			const encryptionKey = yield* parseAlertDestinationEncryptionKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			)
			const destinationDelivery = makeAlertDestinationDelivery({
				encryptionKey,
				appBaseUrl: env.MAPLE_APP_BASE_URL,
				runtime,
				httpClient,
				email,
				postChatAlert: chatAlertPoster.post,
				linear: yield* LinearIssueTracker,
			})
			const {
				hydrateDestination,
				enrichSecretForDispatch,
				composeLinkUrl,
				dispatchDelivery,
				buildPayload,
				sendImmediateNotification,
			} = destinationDelivery
			// Optional: present only inside a Worker isolate. Used to kick off the
			// AI triage Workflow for issues created from freshly opened incidents.
			const chatSessions = Option.getOrUndefined(yield* Effect.serviceOption(ChatSessions))
			const now = runtime.now
			const makeUuid = () => runtime.makeUuid()
			const workerId = makeUuid()
			const rulePersistence = makeAlertRulePersistence({ database, runtime })
			const {
				normalizeRule,
				normalizeRuleRow,
				requireAdmin,
				requireDestinationIds,
				requireRuleRow,
				upsertRuleRow,
			} = rulePersistence

			const dbExecute = makeDbExecute(database, "AlertsService", makePersistenceError)

			// Status pages showing an uptime rule's monitor follow its incidents. Runs after the
			// alert write commits; a failure is logged and never blocks alerting.
			const syncStatusPages = <E>(
				signalType: string,
				context: { readonly orgId: OrgId; readonly alertIncidentId: string },
				write: (db: MapleDb) => Effect.Effect<unknown, E>,
			) =>
				signalType !== "uptime"
					? Effect.void
					: database
							.execute((db) => db.transaction(write(db)))
							.pipe(
								Effect.asVoid,
								Effect.catch((error) =>
									Effect.logWarning("Status page auto incident sync failed").pipe(
										Effect.annotateLogs({
											orgId: context.orgId,
											"maple.alert.incident_id": context.alertIncidentId,
											"error.message": summarizeCause(Cause.fail(error)),
										}),
									),
								),
							)

			/**
			 * Run `write` only while `claim` still owns the rule. The claim row is
			 * locked FOR UPDATE and re-read in the same transaction as the write, so a
			 * later tick's re-claim (an upsert on that row) waits for this commit, and
			 * a write after a re-claim rolls back with `AlertRuleClaimLostError`.
			 * Keep `write` short: it holds the claim row lock. `null` writes unfenced,
			 * for callers that hold no claim.
			 */
			const writeUnderClaim = <A, E, R>(
				claim: RuleClaim | null,
				write: (db: MapleDb) => Effect.Effect<A, E, R>,
			) =>
				dbExecute((db) =>
					claim === null
						? write(db)
						: db.transaction(
								Effect.gen(function* () {
									const current = yield* db.run(
										PG.from(AlertRuleClaims)
											.select("lastScheduledAt")
											.where(($) => [$.ruleId.eq(claim.ruleId)])
											.forUpdate(),
									)
									const currentClaimAt = current[0]?.lastScheduledAt ?? null
									if (currentClaimAt !== claim.claimedAt) {
										return yield* new AlertRuleClaimLostError({
											message: "Alert rule was re-claimed by a later scheduler tick",
											ruleId: claim.ruleId,
											claimedAt: claim.claimedAt,
											currentClaimAt,
										})
									}
									// The claim alone does not cover an edit: a tick holding a
									// snapshot from before it can claim the rule afresh. Locked so
									// an edit waits for this write rather than slipping past it.
									const rule = yield* db.run(
										PG.from(AlertRules)
											.select("updatedAt")
											.where(($) => [$.id.eq(claim.ruleId)])
											.forUpdate(),
									)
									if (rule[0]?.updatedAt !== claim.ruleUpdatedAt) {
										return yield* new AlertRuleClaimLostError({
											message: "Alert rule was edited after this tick loaded it",
											ruleId: claim.ruleId,
											claimedAt: claim.claimedAt,
											currentClaimAt,
										})
									}
									return yield* write(db)
								}),
							),
				)

			/**
			 * `writeUnderClaim` for the state upsert, in one statement instead of five round
			 * trips. FOR SHARE on the claim, then the rule (the edit path's lock order), makes
			 * a re-claim or an edit wait for this write, and a write after one finds no fence
			 * row and changes nothing. Non-finite `lastValue`s travel as null in the JSON.
			 */
			const upsertStatesUnderClaim = Effect.fnUntraced(function* (
				claim: RuleClaim,
				rows: ReadonlyArray<AlertRuleStateRow>,
			) {
				const payload = JSON.stringify(
					rows.map((row) => ({
						org_id: row.orgId,
						rule_id: row.ruleId,
						group_key: row.groupKey,
						consecutive_breaches: row.consecutiveBreaches,
						consecutive_healthy: row.consecutiveHealthy,
						history_json: row.historyJson,
						last_status: row.lastStatus,
						last_value: row.lastValue,
						last_sample_count: row.lastSampleCount,
						last_evaluated_at:
							row.lastEvaluatedAt === null ? null : msToSqlTimestamp(row.lastEvaluatedAt),
						last_error: row.lastError,
						last_error_kind: row.lastErrorKind,
						updated_at: msToSqlTimestamp(row.updatedAt),
					})),
				)
				const result = yield* dbExecute((db) =>
					db.query(
						Orm.sql`
						with claim as (
							select 1 from alert_rule_claims
							where rule_id = ${claim.ruleId}
								and last_scheduled_at = ${msToSqlTimestamp(claim.claimedAt)}::timestamptz
							for share
						), rule as (
							select 1 from alert_rules
							where id = ${claim.ruleId}
								and updated_at = ${msToSqlTimestamp(claim.ruleUpdatedAt)}::timestamptz
								and exists (select 1 from claim)
							for share
						), written as (
							insert into alert_rule_states (
								org_id, rule_id, group_key, consecutive_breaches, consecutive_healthy, history_json,
								last_status, last_value, last_sample_count, last_evaluated_at, last_error,
								last_error_kind, updated_at
							)
							select
								r.org_id, r.rule_id, r.group_key, r.consecutive_breaches, r.consecutive_healthy,
								nullif(r.history_json, 'null'::jsonb), r.last_status, r.last_value,
								r.last_sample_count, r.last_evaluated_at, r.last_error, r.last_error_kind, r.updated_at
							from jsonb_to_recordset(${payload}::jsonb) as r(
								org_id text, rule_id text, group_key text, consecutive_breaches int4,
								consecutive_healthy int4, history_json jsonb, last_status text, last_value float8,
								last_sample_count int4, last_evaluated_at timestamptz, last_error text,
								last_error_kind text, updated_at timestamptz
							)
							where exists (select 1 from rule)
							on conflict (org_id, rule_id, group_key) do update set
								consecutive_breaches = excluded.consecutive_breaches,
								consecutive_healthy = excluded.consecutive_healthy,
								history_json = excluded.history_json,
								last_status = excluded.last_status,
								last_value = excluded.last_value,
								last_sample_count = excluded.last_sample_count,
								last_evaluated_at = excluded.last_evaluated_at,
								last_error = excluded.last_error,
								last_error_kind = excluded.last_error_kind,
								updated_at = excluded.updated_at
							returning 1
						)
						select (select count(*) from rule)::int as fenced`,
						FenceResultRow,
					),
				)
				if ((result[0]?.fenced ?? 0) > 0) return
				// Lost. Only this path pays the read that says to whom.
				const current = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertRuleClaims)
							.select("lastScheduledAt")
							.where(($) => [$.ruleId.eq(claim.ruleId)]),
					),
				)
				const currentClaimAt = current[0]?.lastScheduledAt ?? null
				return yield* new AlertRuleClaimLostError({
					message:
						currentClaimAt === claim.claimedAt
							? "Alert rule was edited after this tick loaded it"
							: "Alert rule was re-claimed by a later scheduler tick",
					ruleId: claim.ruleId,
					claimedAt: claim.claimedAt,
					currentClaimAt,
				})
			})

			/**
			 * Write a rule's buffered state rows in one claim-fenced statement.
			 * Per-group transactions ran back to back and took ~950 ms each at peak,
			 * so a 30-group rule kept the tick open ~30 s past its deadline.
			 */
			const flushRuleStates = Effect.fn("AlertsService.flushRuleStates")(function* (
				claim: RuleClaim,
				writes: RuleStateWrites,
				pendingChecks: Ref.Ref<Chunk.Chunk<AlertChecksRow>>,
			) {
				const buffer = yield* Ref.getAndSet(writes, emptyRuleStateBuffer)
				const rows = Arr.fromIterable(HashMap.values(buffer.rows))
				yield* Effect.annotateCurrentSpan("maple.alerting.state_rows", rows.length)
				if (Arr.isReadonlyArrayEmpty(rows)) return
				yield* upsertStatesUnderClaim(claim, rows).pipe(
					// One write now carries every deferred group, so a transient failure
					// would drop the whole rule's progress. The upsert is idempotent and
					// re-fenced, so retry once; a lost claim or an edit stays final.
					Effect.retry({
						times: 1,
						while: (error) => !(error instanceof AlertRuleClaimLostError),
					}),
				)
				// Only now do the checks count: a failed flush must not report
				// evaluations whose state never reached Postgres.
				yield* Ref.update(pendingChecks, Chunk.appendAll(buffer.checks))
			})

			// Flushes after the groups even when one fails, so a later group's error
			// cannot discard the evaluations that already completed.
			const withRuleStateFlush =
				(
					claim: RuleClaim,
					writes: RuleStateWrites,
					pendingChecks: Ref.Ref<Chunk.Chunk<AlertChecksRow>>,
				) =>
				<A, E, R>(groups: Effect.Effect<A, E, R>) =>
					Effect.gen(function* () {
						const exit = yield* Effect.exit(groups)
						const flush = flushRuleStates(claim, writes, pendingChecks)
						yield* Exit.isSuccess(exit)
							? flush
							: flush.pipe(
									Effect.ignore({
										log: "Warn",
										message: "Failed to flush alert rule states after a failed group",
									}),
								)
						return yield* exit
					})

			/**
			 * Services a rule's telemetry-liveness probe should cover. An empty list
			 * means the rule is org-wide, and the probe falls back to the org pulse.
			 */
			const livenessServicesFor = (rule: NormalizedRule): ReadonlyArray<string> =>
				rule.serviceNames.length > 0
					? rule.serviceNames
					: rule.serviceName != null
						? [rule.serviceName]
						: []

			/**
			 * Would resolving this incident be believing an absence rather than an
			 * observation? Compares the window that looks recovered against the
			 * equivalent window before the incident opened.
			 */
			/**
			 * The services an incident's silence has to be checked against. A rule
			 * grouped by service names the service in the group key, so a quiet
			 * group is probed on its own rather than against the rule's whole scope
			 * — otherwise one loud sibling service would satisfy the probe for a
			 * group that went dark.
			 */
			const livenessServicesForIncident = (
				rule: NormalizedRule,
				groupKey: string | null,
			): ReadonlyArray<string> =>
				groupKey != null &&
				groupKey !== UNGROUPED_GROUP_KEY &&
				// Service-grouped rules and multi-service rules both key incidents by
				// service name; in either case the quiet service is probed alone, so
				// a loud sibling cannot vouch for it.
				(isServiceGroupBy(rule.groupBy) || rule.serviceNames.includes(groupKey))
					? [groupKey]
					: livenessServicesFor(rule)

			const telemetryStillFlowing = Effect.fn("AlertsService.telemetryStillFlowing")(function* (
				orgId: OrgId,
				normalized: NormalizedRule,
				incidentOpenedAtMs: number,
				timestamp: number,
				serviceNames: ReadonlyArray<string> = livenessServicesFor(normalized),
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const windowMs = Math.max(normalized.windowMinutes, 1) * 60_000
				const dayMs = 24 * 60 * 60_000
				return yield* probeLiveness({
					warehouse,
					tenant: systemTenant(orgId),
					serviceNames,
					environments: normalized.environments,
					windowStartMs: timestamp - windowMs,
					windowEndMs: timestamp,
					baselineStartMs: incidentOpenedAtMs - windowMs,
					baselineEndMs: incidentOpenedAtMs,
					// Yesterday, same clock time: the traffic this hour normally has.
					// The onset window above is only the fallback for a service that
					// did not exist a day ago.
					priorDayBaselineStartMs: timestamp - dayMs - windowMs,
					priorDayBaselineEndMs: timestamp - dayMs,
				})
			})

			/**
			 * The one decision both resolve paths make when a breach stops showing
			 * up: believe the absence and resolve, or hold the incident open because
			 * the telemetry it needs may have stopped too.
			 *
			 * A hold is a sub-state of `open` (`holdReason` + `heldSince` on the
			 * row), bounded by `holdCeilingMs` per reason: past the ceiling the
			 * absence is believed anyway, with a resolve reason that says so. The
			 * clock starts at the first held tick and survives reason changes, so a
			 * probe flipping between `volume_collapsed` and `no_data` cannot reset it.
			 *
			 * Never decides on a stale hold: an incident that re-breached since it
			 * was last held arrives here with the hold already cleared by the
			 * breach path, so `heldSince` always dates the current quiet spell.
			 */
			const decideLivenessGate = (
				incident: Pick<AlertIncidentRow, "holdReason" | "heldSince">,
				liveness: LivenessVerdict,
				windowMinutes: number,
				timestamp: number,
			): LivenessGateDecision => {
				if (liveness.dataFlowing) {
					return {
						kind: "resolve",
						reason:
							incident.holdReason === null
								? null
								: "Auto-resolved: telemetry resumed and the breach did not",
						heldForMs: incident.heldSince === null ? 0 : timestamp - incident.heldSince,
					}
				}
				const reason = liveness.reason
				if (reason === "ok" || reason === "no_baseline") {
					// `dataFlowing` false only pairs with a hold reason; the exhaustive
					// switch in `holdCeilingMs` keeps the type honest here.
					return { kind: "resolve", reason: null, heldForMs: 0 }
				}
				const heldSinceMs = incident.heldSince === null ? timestamp : incident.heldSince
				const ceiling = holdCeilingMs(reason, windowMinutes)
				if (ceiling !== null && timestamp - heldSinceMs >= ceiling) {
					return {
						kind: "resolve",
						reason: `Auto-resolved: no breach observed for ${Math.round(
							(timestamp - heldSinceMs) / 60_000,
						)} minutes while telemetry was ${describeHold(reason)}`,
						heldForMs: timestamp - heldSinceMs,
					}
				}
				return { kind: "hold", reason, heldSinceMs, ceilingMs: ceiling }
			}

			/**
			 * Persist a hold on an open incident. Idempotent: an incident already held
			 * for the same reason writes nothing, so a long hold stays quiet on the
			 * Electric shape; a reason change updates the reason but keeps the clock.
			 */
			const recordHold = Effect.fn("AlertsService.recordHold")(function* (
				incident: AlertIncidentRow,
				decision: Extract<LivenessGateDecision, { kind: "hold" }>,
				liveness: LivenessVerdict,
				timestamp: number,
				claim: RuleClaim | null,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.alert.incident_id": incident.id,
					"maple.alert.hold_reason": decision.reason,
				})
				if (incident.holdReason === null) {
					yield* Effect.logInfo(
						"Incident held: breach absent but telemetry not provably flowing",
					).pipe(
						Effect.annotateLogs({
							orgId: incident.orgId,
							ruleId: incident.ruleId,
							incidentId: incident.id,
							groupKey: incident.groupKey,
							holdReason: decision.reason,
							holdCeilingMinutes:
								decision.ceilingMs === null ? null : decision.ceilingMs / 60_000,
							observedCount: liveness.observedCount,
							baselineCount: liveness.baselineCount,
						}),
					)
					yield* Metric.update(AlertingMetrics.incidentsHeldTotal, 1)
				}
				if (incident.holdReason === decision.reason) return
				yield* writeUnderClaim(claim, (db) =>
					db.run(
						PG.update(AlertIncidents)
							.set({
								holdReason: decision.reason,
								heldSince: incident.heldSince ?? decision.heldSinceMs,
								updatedAt: timestamp,
							})
							.where(($) => [$.id.eq(incident.id), $.status.eq("open")]),
					),
				)
			})

			/**
			 * Evaluate the alert rule and return one outcome per group.
			 *
			 * This is the single boundary between the query engine's group-key
			 * vocabulary and storage's. The engine emits a generic `"all"` for an
			 * ungrouped result; every returned `groupKey` here is already in storage
			 * vocabulary — `UNGROUPED_GROUP_KEY` for an ungrouped plan, a real group
			 * name otherwise — so no caller re-derives it. For grouped rules every
			 * distinct value (or composite value, when multiple dimensions are
			 * picked) becomes its own entry, processed and dedup'd independently
			 * downstream.
			 */
			const evaluateRule = Effect.fn("AlertsService.evaluateRule")(function* (
				orgId: OrgId,
				rule: NormalizedRule,
				windowEndMs?: number,
			): Effect.fn.Return<
				ReadonlyArray<{ evaluation: EvaluatedRule; groupKey: string }>,
				| AlertValidationError
				| AlertPersistenceError
				| QueryEngineValidationError
				| QueryEngineTimeoutError
				| WarehouseQueryPathError
			> {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": rule.id })
				// An uptime rule observes its monitor, never the warehouse, and never skips:
				// 1 while down, 0 otherwise. A monitor that is gone observes nothing.
				if (rule.signalType === "uptime") {
					const observation = yield* uptimeAlerts
						.observe(orgId, rule.id, yield* now)
						.pipe(Effect.mapError(makePersistenceError))
					return Option.match(observation, {
						onNone: () => [],
						onSome: (observed) => [
							{
								evaluation: applyEvaluationLogic(
									rule,
									{ value: observed.down ? 1 : 0, sampleCount: 1, hasData: true },
									observed.detail ?? "The check is passing",
								),
								groupKey: observed.groupKey,
							},
						],
					})
				}
				// Snapped, not raw `now`: excludes the still-filling current minute and
				// lets rules over the same signal share bucket reads within a tick. See
				// `snapAlertWindowEndMs`. A scheduler tick passes its own.
				const endMs = windowEndMs === undefined ? snapAlertWindowEndMs(yield* now) : windowEndMs
				const startMs = endMs - rule.windowMinutes * 60_000
				const plan = rule.compiledPlan
				const source = yield* planEvaluateSource(plan, rule)
				const observations: ReadonlyArray<GroupedAlertObservation> = yield* queryEngine.evaluate(
					systemTenant(orgId),
					{
						startTime: formatWarehouseDateTime(startMs),
						endTime: formatWarehouseDateTime(endMs),
						source,
						reducer: plan.reducer,
						sampleCountStrategy: plan.sampleCountStrategy,
					},
				)

				return observations.map((obs) => ({
					evaluation: applyEvaluationLogic(rule, obs),
					groupKey: toStorageGroupKey(plan, obs.groupKey),
				}))
			})

			/** What an empty result observes: the engine's no-data fallback. */
			const EMPTY_OBSERVATION = { value: null, sampleCount: 0, hasData: false } as const

			const applyEvaluationLogic = (
				rule: NormalizedRule,
				obs: Pick<GroupedAlertObservation, "value" | "sampleCount" | "hasData">,
				reasonOverride?: string,
			): EvaluatedRule =>
				evaluateAlertObservation(
					{
						comparator: rule.comparator,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						tiers: rule.thresholds,
						minimumSampleCount: rule.minimumSampleCount,
						noDataBehavior: rule.compiledPlan.noDataBehavior,
					},
					obs,
					reasonOverride ??
						`${rule.signalType} ${formatComparator(rule.comparator, rule.threshold, rule.thresholdUpper)}`,
				)

			const buildDeliveryKey = (
				incidentId: string,
				destinationId: string,
				eventType: AlertEventTypeValue,
				scheduledAt: number,
			) => makeAlertDeliveryKey(incidentId, destinationId, eventType, scheduledAt)

			const insertDeliveryEventRecord = (
				orm: MapleDb,
				orgId: OrgId,
				incidentId: AlertIncidentId | null,
				ruleId: AlertRuleId,
				destinationId: AlertDestinationId,
				eventType: AlertEventTypeValue,
				payload: Record<string, unknown>,
				scheduledAt: number,
				deliveryKey: string,
				attemptNumber: number,
			) =>
				orm.run(
					PG.insertInto(AlertDeliveryEvents)
						.values({
							id: decodeAlertDeliveryEventIdSync(makeUuid()),
							orgId,
							incidentId,
							ruleId,
							destinationId,
							deliveryKey,
							eventType,
							attemptNumber,
							status: "queued",
							scheduledAt: scheduledAt,
							claimedAt: null,
							claimExpiresAt: null,
							claimedBy: null,
							attemptedAt: null,
							providerMessage: null,
							providerReference: null,
							responseCode: null,
							errorMessage: null,
							payloadJson: payload,
							createdAt: scheduledAt,
							updatedAt: scheduledAt,
						})
						.onConflictDoNothing(),
				)

			const insertDeliveryEvent = Effect.fn("AlertsService.insertDeliveryEvent")(function* (
				orgId: OrgId,
				incidentId: AlertIncidentId | null,
				ruleId: AlertRuleId,
				destinationId: AlertDestinationId,
				eventType: AlertEventTypeValue,
				payload: Record<string, unknown>,
				scheduledAt: number,
				deliveryKey: string,
				attemptNumber: number,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.alert.rule_id": ruleId,
					"maple.alert.destination_id": destinationId,
				})
				yield* dbExecute((db) =>
					insertDeliveryEventRecord(
						db,
						orgId,
						incidentId,
						ruleId,
						destinationId,
						eventType,
						payload,
						scheduledAt,
						deliveryKey,
						attemptNumber,
					),
				)
			})

			const resolveNotificationLinkUrl = (
				rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
				groupKey: string | null,
				incidentId: string | null,
			) => composeLinkUrl(resolveServiceLinkName(rule, groupKey), incidentId)

			const toDeliveryAttemptFailure = (
				error:
					| AlertValidationError
					| AlertDeliveryFailure
					| AlertPersistenceError
					| AlertDestinationStorageError
					| AlertRuleStoredConfigInvalidError,
			): DeliveryAttemptFailure => ({
				message: error.message,
				kind: error.error.code,
				retryable: error.error.retryable,
			})

			/**
			 * The phone push for an incident event. Per person, not per rule, so it
			 * runs regardless of destinations. Best-effort by contract: it never
			 * fails the tick.
			 */
			const pushIncidentNotification = Effect.fn("AlertsService.pushIncidentNotification")(function* (
				orgId: OrgId,
				rule: NormalizedRule,
				incident: AlertIncidentRow,
				evaluation: EvaluatedRule,
				eventType: AlertEventTypeValue,
				scheduledAt: number,
				// Null on the ad-hoc paths (a rule edit resolving its own
				// incidents): those are one user action, not a storm.
				pushBudget: IncidentPushBudget | null,
				// Set on a resolve that ends a hold: the phone copy says the
				// breach stopped while telemetry was reduced, not "back to X".
				resolvedAfterHold: ResolvedAfterHold | null,
			) {
				const linkUrl = resolveNotificationLinkUrl(rule, incident.groupKey, incident.id)
				const pushAllowed =
					pushBudget === null ||
					(yield* pushBudget.claim({
						orgId,
						ruleId: rule.id,
						ruleName: rule.name,
						severity: rule.severity,
						// A digest can cover several incidents of the rule, so it links the rule's page, not one incident.
						linkUrl: resolveNotificationLinkUrl(rule, incident.groupKey, null),
						kind: eventType === "resolve" ? "resolve" : "firing",
					}))
				if (pushAllowed) {
					yield* mobilePush
						.notifyIncident({
							orgId,
							eventType,
							incidentId: incident.id,
							ruleId: rule.id,
							ruleName: rule.name,
							severity: rule.severity,
							signalType: rule.signalType,
							signalDisplay: resolveSignalDisplay({
								signalType: rule.signalType,
								queryBuilderDraft: rule.queryBuilderDraft,
								rawQueryReducer: rule.rawQueryReducer,
							}),
							comparator: rule.comparator,
							threshold: rule.threshold,
							thresholdUpper: rule.thresholdUpper,
							value: evaluation.value,
							detail: rule.signalType === "uptime" ? evaluation.reason : null,
							groupKey: incident.groupKey,
							serviceNames: rule.serviceNames,
							windowMinutes: rule.windowMinutes,
							dedupeKey: incident.dedupeKey,
							// Always, not just on resolve: how long an incident has been
							// open is what the renotify escalation ladder is a function
							// of, and it is the subtitle of every repeat banner.
							openForMs: Math.max(0, scheduledAt - incident.firstTriggeredAt),
							// Read from the incident BEFORE the tick advanced
							// `lastNotifiedAt` — this is the previous notification, which
							// is the other end of the interval the ladder measures.
							previousNotifiedOpenForMs:
								incident.lastNotifiedAt === null
									? null
									: Math.max(0, incident.lastNotifiedAt - incident.firstTriggeredAt),
							resolvedAfterHold,
							linkUrl,
							// Unevaluated: the Lock Screen sparkline is the only
							// consumer, so this warehouse read happens for a critical
							// incident on a phone that can show one, and nowhere else.
							recentValues: readModels
								.listRuleChecks(orgId, rule.id, {
									...(incident.groupKey === null
										? undefined
										: { groupKey: incident.groupKey }),
									limit: LIVE_ACTIVITY_CHECK_HISTORY,
								})
								.pipe(
									Effect.map((page) =>
										page.checks.flatMap((check) =>
											check.observedValue === null ? [] : [check.observedValue],
										),
									),
									// A missing chart is a smaller loss than a missing
									// notification: never let this fail the push.
									Effect.orElseSucceed(() => [] as ReadonlyArray<number>),
								),
						})
						.pipe(Effect.timeout("20 seconds"), Effect.ignoreCause)
				} else {
					yield* Effect.logInfo(
						"Mobile push: over this rule's per-tick share, folding the incident into the digest",
					).pipe(Effect.annotateLogs({ orgId, ruleId: rule.id, incidentId: incident.id }))
				}
			})

			/**
			 * The delivery rows an incident event queues, one per enabled destination.
			 * Does the slow reads (destinations, chart series) so the write that
			 * queues them can stay short; `insertIncidentDeliveries` writes them.
			 */
			const prepareIncidentDeliveries = Effect.fn("AlertsService.prepareIncidentDeliveries")(function* (
				orgId: OrgId,
				rule: NormalizedRule,
				incident: AlertIncidentRow,
				evaluation: EvaluatedRule,
				eventType: AlertEventTypeValue,
				scheduledAt: number,
			) {
				// A resolve also reaches every destination this incident already
				// notified, so a rule edit that drops one cannot orphan its alert.
				const priorDestinationIds =
					eventType === "resolve"
						? (yield* dbExecute((db) =>
								db.run(
									PG.from(AlertDeliveryEvents)
										.select("destinationId")
										.where(($) => [$.orgId.eq(orgId), $.incidentId.eq(incident.id)]),
								),
							)).map((row) => row.destinationId)
						: []
				const destinationIds = Arr.dedupe([...rule.destinationIds, ...priorDestinationIds])
				if (destinationIds.length === 0) return []

				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertDestinations)
							.select("id", "enabled")
							.where(($) => [$.orgId.eq(orgId), $.id.in_(...destinationIds)]),
					),
				)

				const destinations = new Map(rows.map((row) => [row.id, row]))

				// Once per notification, not once per destination: N destinations
				// on one rule must not mean N reads of the same series. Never
				// fails — `loadChartSeries` answers `null` for every problem it
				// can have, so a slow or broken warehouse costs the sparkline and
				// nothing else.
				const window = chartWindow({
					incidentStartedAtMs: incident.firstTriggeredAt,
					nowMs: scheduledAt,
					windowMinutes: rule.windowMinutes,
				})
				// An uptime rule's series is a 0/1 step that says less than the check's error, so it gets no chart.
				const series =
					rule.signalType === "uptime"
						? null
						: yield* loadChartSeries(warehouse, systemTenant(orgId), {
								orgId,
								ruleId: rule.id,
								groupKey: incident.groupKey,
								comparator: rule.comparator,
								threshold: rule.threshold,
								...window,
							})

				// The image URL rides with the series it describes: both pin the
				// same window, so a retry an hour later renders the same picture
				// this notification was written about.
				const display = resolveSignalDisplay(rule)
				const displayGroup = incident.groupKey === "__total__" ? null : incident.groupKey
				const chartUrl =
					series === null
						? null
						: chartImageUrl({
								appBaseUrl: env.MAPLE_APP_BASE_URL,
								hmacKey: Option.match(env.MAPLE_SHARE_TOKEN_HMAC_KEY, {
									onNone: () => null,
									onSome: (key) => Redacted.value(key),
								}),
								orgId,
								ruleId: rule.id,
								groupKey: incident.groupKey,
								...window,
								title: displayGroup ? `${display.label} · ${displayGroup}` : display.label,
								unit: mapSignalUnit(display.unit),
								threshold: series.threshold,
								breachSide: series.breachSide,
							})

				const payload = yield* buildPayload(
					{
						eventType,
						incidentId: incident.id,
						incidentStatus: decodeAlertIncidentStatusSync(incident.status),
						dedupeKey: incident.dedupeKey,
						ruleId: rule.id,
						ruleName: rule.name,
						groupKey: incident.groupKey,
						signalType: rule.signalType,
						severity: rule.severity,
						// Snapshotted with the event: a retry or a late delivery
						// must page the key this event was raised under.
						ruleSeverities: rule.thresholds.map((tier) => tier.severity),
						...(incident.peakSeverity === null
							? undefined
							: { incidentPeakSeverity: decodeAlertSeveritySync(incident.peakSeverity) }),
						comparator: rule.comparator,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						windowMinutes: rule.windowMinutes,
						value: evaluation.value,
						sampleCount: evaluation.sampleCount,
						// The evaluator puts the check's error in the reason of an uptime rule.
						detail: rule.signalType === "uptime" ? evaluation.reason : null,
						sparkline: series?.sparkline ?? null,
						chartUrl,
						template: rule.notificationTemplate,
						linkUrl: resolveNotificationLinkUrl(rule, incident.groupKey, incident.id),
						sentAtMs: scheduledAt,
					},
					orgId,
				).pipe(Effect.mapError((error) => makeValidationError(error.message, [], error)))

				return destinationIds.flatMap((destinationId): ReadonlyArray<PreparedIncidentDelivery> => {
					const destination = destinations.get(destinationId)
					if (!destination || !destination.enabled) return []
					return [
						{
							orgId,
							incidentId: incident.id,
							ruleId: rule.id,
							destinationId,
							eventType,
							payload,
							scheduledAt,
						},
					]
				})
			})

			const insertIncidentDeliveries = (
				db: MapleDb,
				deliveries: ReadonlyArray<PreparedIncidentDelivery>,
			) =>
				Effect.forEach(
					deliveries,
					(delivery) =>
						insertDeliveryEventRecord(
							db,
							delivery.orgId,
							delivery.incidentId,
							delivery.ruleId,
							delivery.destinationId,
							delivery.eventType,
							delivery.payload,
							delivery.scheduledAt,
							buildDeliveryKey(
								delivery.incidentId,
								delivery.destinationId,
								delivery.eventType,
								delivery.scheduledAt,
							),
							1,
						),
					{ discard: true },
				)

			/** Queue an incident event's deliveries, then push it to phones. */
			const queueIncidentNotifications = Effect.fn("AlertsService.queueIncidentNotifications")(
				function* (
					orgId: OrgId,
					rule: NormalizedRule,
					incident: AlertIncidentRow,
					evaluation: EvaluatedRule,
					eventType: AlertEventTypeValue,
					scheduledAt: number,
					pushBudget: IncidentPushBudget | null,
					resolvedAfterHold: ResolvedAfterHold | null = null,
				) {
					const deliveries = yield* prepareIncidentDeliveries(
						orgId,
						rule,
						incident,
						evaluation,
						eventType,
						scheduledAt,
					)
					if (deliveries.length > 0)
						yield* dbExecute((db) => insertIncidentDeliveries(db, deliveries))
					yield* pushIncidentNotification(
						orgId,
						rule,
						incident,
						evaluation,
						eventType,
						scheduledAt,
						pushBudget,
						resolvedAfterHold,
					)
				},
			)

			// Exponential backoff up to 15 min, plus 0–999 ms jitter sourced from
			// Effect's `Random` service so tests can fix the seed deterministically.
			const computeRetryDelayMs = Effect.fn("AlertsService.computeRetryDelayMs")(function* (
				attemptNumber: number,
			) {
				const jitter = yield* Random.nextIntBetween(0, 1_000)
				return alertDeliveryRetryDelayMs(attemptNumber, jitter)
			})

			const updateRule = Effect.fn("AlertsService.updateRule")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				ruleId: AlertRuleDocument["id"],
				request: AlertRuleUpsertRequest,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"tenant.userId": userId,
					"maple.alert.rule_id": ruleId,
				})
				yield* requireAdmin(roles)
				const oldRow = yield* requireRuleRow(orgId, ruleId)
				if (oldRow.signalType === "uptime") {
					return yield* Effect.fail(makeValidationError(UPTIME_RULE_MANAGED_MESSAGE))
				}
				const oldNormalized = yield* normalizeRuleRow(oldRow)
				const newNormalized = yield* normalizeRule(orgId, request)
				const result = yield* upsertRuleRow(orgId, userId, ruleId, request)

				// Resolve stale incidents caused by the configuration change

				if (oldNormalized.enabled && !newNormalized.enabled) {
					// Rule was disabled — resolve all open incidents
					yield* resolveStaleIncidents(orgId, ruleId, newNormalized, {
						resolveAll: true,
					})
				} else if (ruleStructureChanged(oldNormalized, newNormalized)) {
					// Evaluation mode changed — resolve all and let scheduler re-evaluate fresh
					yield* resolveStaleIncidents(orgId, ruleId, newNormalized, {
						resolveAll: true,
					})
				} else {
					const staleGroupKeys = computeStaleGroupKeys(oldNormalized, newNormalized)
					if (HashSet.size(staleGroupKeys) > 0) {
						yield* resolveStaleIncidents(orgId, ruleId, newNormalized, {
							staleGroupKeys,
						})
					}
				}

				return result
			})

			const testRule = Effect.fn("AlertsService.testRule")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				request: AlertRuleUpsertRequest,
				sendNotification = false,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				yield* requireAdmin(roles)
				const normalized = yield* normalizeRule(orgId, request)
				yield* requireDestinationIds(orgId, normalized.destinationIds)

				let evaluation: EvaluatedRule
				if (normalized.serviceNames.length > 1) {
					const results = yield* Effect.forEach(
						yield* perServiceRules(normalized),
						({ rule }) =>
							Effect.gen(function* () {
								const observations = yield* evaluateRule(orgId, rule)
								return (
									observations[0]?.evaluation ??
									applyEvaluationLogic(rule, EMPTY_OBSERVATION)
								)
							}),
						{ concurrency: 5 },
					)
					evaluation =
						results.find((r) => r.status === "breached") ??
						results[0] ??
						applyEvaluationLogic(normalized, EMPTY_OBSERVATION)
				} else {
					// Uniform grouped/ungrouped path — mirrors runSchedulerTick: the
					// compiled plan decides groupedness, and a breaching group (if any)
					// wins so the test reflects what the scheduler would fire on.
					const allResults = yield* evaluateRule(orgId, normalized)
					const excludeSet = HashSet.fromIterable(normalized.excludeServiceNames)
					const results = isGroupedPlan(normalized.compiledPlan)
						? Arr.filter(allResults, (r) => !HashSet.has(excludeSet, r.groupKey))
						: allResults
					const breached = results.find((r) => r.evaluation.status === "breached")
					evaluation =
						breached?.evaluation ??
						results[0]?.evaluation ??
						applyEvaluationLogic(normalized, EMPTY_OBSERVATION)
				}

				if (sendNotification) {
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(AlertDestinations)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.id.in_(...normalized.destinationIds)]),
						),
					)
					const byId = new Map(rows.map((row) => [row.id, row]))
					const enabledDestinations = normalized.destinationIds
						.map((id) => ({ id, row: byId.get(id) }))
						.filter(
							(d): d is { id: AlertDestinationId; row: AlertDestinationRow } =>
								d.row != null && d.row.enabled,
						)

					const sentAtMs = yield* now
					yield* Effect.forEach(
						enabledDestinations,
						({ id: destinationId, row: destination }) =>
							sendImmediateNotification(destination, {
								deliveryKey: `${orgId}:${destinationId}:rule-test`,
								ruleId: decodeAlertRuleIdSync(makeUuid()),
								ruleName: normalized.name,
								groupKey: null,
								signalType: normalized.signalType,
								signalDisplay: resolveSignalDisplay(normalized),
								severity: normalized.severity,
								comparator: normalized.comparator,
								threshold: normalized.threshold,
								thresholdUpper: normalized.thresholdUpper,
								windowMinutes: normalized.windowMinutes,
								eventType: "test",
								incidentId: null,
								incidentStatus: "resolved",
								dedupeKey: `${orgId}:${destinationId}:rule-test`,
								value: evaluation.value,
								sampleCount: evaluation.sampleCount,
								template: normalized.notificationTemplate,
								linkUrl: resolveNotificationLinkUrl(normalized, null, null),
								sentAtMs,
							}),
						{ concurrency: ALERT_TEST_DELIVERY_CONCURRENCY },
					)
				}

				return new AlertEvaluationResult(evaluation)
			})

			/**
			 * Times one check of a raw SQL rule on the latest window under the top interval's
			 * limit, so the editor can say which intervals the query fits. Evaluation is not
			 * cached, so the time is the query's own. Null when it fails for another reason:
			 * the preview's series query reports that.
			 */
			// Previews of raw SQL run under the longest interval's limit: they read many windows at
			// once, and say whether one check fits the rule's own limit through `queryTiming`.
			const PREVIEW_RAW_INTERVAL_MINUTES = 60

			const probeQueryTiming = Effect.fn("AlertsService.probeQueryTiming")(function* (
				orgId: OrgId,
				rule: NormalizedRule,
			) {
				const probeLimitMs = alertQueryLimits(PREVIEW_RAW_INTERVAL_MINUTES).timeSeconds * 1000
				const endMs = snapAlertWindowEndMs(yield* now)
				const source = yield* planEvaluateSource(rule.compiledPlan, {
					windowMinutes: rule.windowMinutes,
					evaluationIntervalMinutes: PREVIEW_RAW_INTERVAL_MINUTES,
				})
				const startedAt = yield* now
				const exit = yield* Effect.exit(
					queryEngine.evaluate(systemTenant(orgId), {
						startTime: formatWarehouseDateTime(endMs - rule.windowMinutes * 60_000),
						endTime: formatWarehouseDateTime(endMs),
						source,
						reducer: rule.compiledPlan.reducer,
						sampleCountStrategy: rule.compiledPlan.sampleCountStrategy,
					}),
				)
				const elapsedMs = (yield* now) - startedAt
				const failure = Exit.isFailure(exit)
					? Option.match(Cause.findErrorOption(exit.cause), {
							onNone: () => "other" as const,
							// The engine's own 30s ceiling is a query that did not finish either.
							onSome: (error) =>
								error._tag === "@maple/http/errors/QueryEngineTimeoutError"
									? ("query_too_slow" as const)
									: evaluationErrorKind(error),
						})
					: null
				if (failure !== null && failure !== "query_too_slow" && failure !== "query_too_much_memory") {
					yield* Effect.logWarning("Alert preview query timing failed").pipe(
						Effect.annotateLogs({ orgId, ruleId: rule.id, errorKind: failure }),
					)
					return undefined
				}
				const intervalMinutes = alertRuleIntervalMinutes(rule)
				yield* Effect.annotateCurrentSpan({
					"maple.alert.query_timing.elapsed_ms": elapsedMs,
					"maple.alert.query_timing.failure": failure ?? "none",
				})
				return new AlertQueryTiming({
					elapsedMs: failure === null ? elapsedMs : null,
					failure,
					probeLimitMs,
					intervalMinutes,
					limitMs: alertQueryLimits(intervalMinutes).timeSeconds * 1000,
					// Within the window, since validation refuses a longer interval.
					fitsIntervalMinutes:
						failure === null
							? alertIntervalsFitting(elapsedMs).filter(
									(minutes) => minutes <= rule.windowMinutes,
								)
							: [],
				})
			})

			/**
			 * Evaluator-faithful preview of a rule over a time range. Runs the exact
			 * compiled plan the scheduler runs, at the evaluator's tumbling
			 * `windowMinutes` buckets, and simulates the consecutive-breach state
			 * machine to report when the rule would have fired. One bucket == one
			 * evaluation window, so what this returns is what the tracking chart
			 * shows once the rule is live.
			 *
			 * Fidelity caveat: the live scheduler slides its window every check
			 * (`alertRuleIntervalMinutes`) while the preview uses tumbling
			 * windows, so `wouldFire` spans are approximate between bucket boundaries.
			 */
			const previewRule = Effect.fn("AlertsService.previewRule")(function* (
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
				request: AlertRulePreviewRequest,
			): Effect.fn.Return<
				AlertRulePreviewResponse,
				| AlertValidationError
				| AlertForbiddenError
				| QueryEngineValidationError
				| QueryEngineTimeoutError
				| WarehouseQueryPathError
			> {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const normalized = yield* normalizeRule(orgId, request.rule, {
					forPreview: true,
				})
				const plan = normalized.compiledPlan

				// Preview only needs `alerts:read`, but a raw-SQL rule executes
				// user-authored ClickHouse against the org's warehouse — the same
				// capability `createRule`/`testRule` gate behind org-admin. Previewing
				// one must not be a cheaper route to that than creating it.
				if (plan.kind === "raw_sql") {
					yield* requireAdmin(roles)
				}
				// Alongside the series query, which spans many windows and so says nothing about one check.
				const queryTiming = yield* Effect.forkChild(
					plan.kind === "raw_sql" ? probeQueryTiming(orgId, normalized) : Effect.succeed(undefined),
				)

				const windowMs = normalized.windowMinutes * 60_000
				const requestedStartMs = parseWarehouseDateTime(request.startTime)
				const requestedEndMs = parseWarehouseDateTime(request.endTime)
				if (
					!Number.isFinite(requestedStartMs) ||
					!Number.isFinite(requestedEndMs) ||
					requestedEndMs <= requestedStartMs
				) {
					return yield* Effect.fail(makeValidationError("Invalid preview time range"))
				}

				// Tumbling windows aligned to the epoch — the same alignment the CH
				// timeseries bucketing (toStartOfInterval) uses, so the preview grid
				// lines up with the rows evaluateSeries returns.
				const endMs = Math.floor(requestedEndMs / windowMs) * windowMs
				const alignedStartMs = Math.floor(requestedStartMs / windowMs) * windowMs
				const maxBuckets = MAX_PREVIEW_BUCKETS
				const minStartMs = endMs - maxBuckets * windowMs
				const startMs = Math.max(alignedStartMs, minStartMs)
				if (endMs - startMs < windowMs) {
					return yield* Effect.fail(
						makeValidationError("Preview range must span at least one evaluation window"),
					)
				}
				const truncatedToStart =
					alignedStartMs < minStartMs
						? decodeIsoDateTimeStringSync(new Date(startMs).toISOString())
						: null

				const bucketStarts: number[] = []
				for (let t = startMs; t + windowMs <= endMs; t += windowMs) {
					bucketStarts.push(t)
				}

				// The trailing in-progress window [endMs, requestedEndMs) — evaluated as a
				// provisional bucket keyed at endMs so the chart reaches "now" instead of
				// dropping up to a full window of the freshest data. Its rows land in the
				// epoch-aligned bucket starting at endMs, so the series query just extends.
				const hasPartialBucket = requestedEndMs - endMs >= 60_000
				const queryEndMs = hasPartialBucket ? requestedEndMs : endMs
				const pointBuckets = hasPartialBucket ? Arr.append(bucketStarts, endMs) : bucketStarts

				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.alert.plan_kind": plan.kind,
					"maple.alert.window_minutes": normalized.windowMinutes,
					"maple.alert.preview.buckets": pointBuckets.length,
					"maple.alert.preview.has_partial_bucket": hasPartialBucket,
				})

				// Raw per-(group, bucket) observations; buckets missing here are
				// no-data windows and get filled from the grid below.
				interface PreviewObs {
					readonly value: number | null
					readonly sampleCount: number
					readonly hasData: boolean
				}
				const obsByGroup = new Map<string, Map<number, PreviewObs>>()
				const record = (groupKey: string, bucketMs: number, obs: PreviewObs) => {
					let buckets = obsByGroup.get(groupKey)
					if (!buckets) {
						buckets = new Map()
						obsByGroup.set(groupKey, buckets)
					}
					buckets.set(bucketMs, obs)
				}

				if (normalized.serviceNames.length > 1) {
					// Mirror the scheduler's multi-service mode: independent per-service
					// plans, groupKey = service name.
					yield* Effect.forEach(
						yield* perServiceRules(normalized),
						({ groupKey, rule }) =>
							Effect.gen(function* () {
								const observations = yield* queryEngine.evaluateSeries(systemTenant(orgId), {
									startTime: formatWarehouseDateTime(startMs),
									endTime: formatWarehouseDateTime(queryEndMs),
									source: yield* planEvaluateSource(rule.compiledPlan, rule),
									reducer: rule.compiledPlan.reducer,
									sampleCountStrategy: rule.compiledPlan.sampleCountStrategy,
								})
								for (const obs of observations) {
									record(groupKey, parseWarehouseDateTime(obs.bucket), {
										value: obs.value,
										sampleCount: obs.sampleCount,
										hasData: obs.sampleCount > 0,
									})
								}
							}),
						{ concurrency: 5 },
					)
				} else {
					const source = yield* planEvaluateSource(
						plan,
						plan.kind === "raw_sql"
							? { ...normalized, evaluationIntervalMinutes: PREVIEW_RAW_INTERVAL_MINUTES }
							: normalized,
					)
					const charted = yield* queryEngine
						.evaluateSeries(systemTenant(orgId), {
							startTime: formatWarehouseDateTime(startMs),
							endTime: formatWarehouseDateTime(queryEndMs),
							source,
							reducer: plan.reducer,
							sampleCountStrategy: plan.sampleCountStrategy,
						})
						.pipe(
							Effect.map((observations) => ({ observations, failure: null })),
							// A raw query too heavy to chart the whole range still gets its one-check timing back.
							Effect.catchIf(
								(error) =>
									plan.kind === "raw_sql" &&
									isQueryLimitFailure(evaluationErrorKind(error)),
								(error) =>
									Effect.succeed({
										observations: [],
										failure:
											evaluationErrorKind(error) === "query_too_much_memory"
												? ("query_too_much_memory" as const)
												: ("query_too_slow" as const),
									}),
							),
						)
					if (charted.failure !== null) {
						const timing = yield* Fiber.join(queryTiming)
						return new AlertRulePreviewResponse({
							bucketSeconds: windowMs / 1000,
							windowMinutes: normalized.windowMinutes,
							threshold: normalized.threshold,
							thresholdUpper: normalized.thresholdUpper,
							thresholds: normalized.thresholds,
							comparator: normalized.comparator,
							truncatedToStart,
							series: [],
							wouldFire: [],
							seriesFailure: charted.failure,
							...(timing === undefined ? undefined : { queryTiming: timing }),
						})
					}
					const observations = charted.observations
					const excludeSet = HashSet.fromIterable(normalized.excludeServiceNames)
					// Preview must key its series exactly as the scheduler stores them,
					// or the preview chart and the tracking chart disagree on the
					// ungrouped series' name.
					for (const obs of observations) {
						if (HashSet.has(excludeSet, obs.groupKey)) continue
						record(toStorageGroupKey(plan, obs.groupKey), parseWarehouseDateTime(obs.bucket), {
							value: obs.value,
							sampleCount: obs.sampleCount,
							hasData: obs.sampleCount > 0,
						})
					}
				}

				// The scheduler observes *something* every tick: an empty result becomes one
				// no-data observation (per service in multi-service mode), keyed as storage
				// keys it. Chart that series too, or a query matching nothing previews as nothing.
				if (normalized.serviceNames.length > 1) {
					for (const serviceName of normalized.serviceNames) {
						if (!obsByGroup.has(serviceName)) obsByGroup.set(serviceName, new Map())
					}
				} else if (obsByGroup.size === 0) {
					obsByGroup.set(toStorageGroupKey(plan, ENGINE_UNGROUPED_GROUP_KEY), new Map())
				}

				const NO_DATA: PreviewObs = {
					value: null,
					sampleCount: 0,
					hasData: false,
				}
				const iso = (ms: number) => decodeIsoDateTimeStringSync(new Date(ms).toISOString())

				// The scheduler never evaluates a group that is missing from a tick; with
				// alert-on-no-data it breaches only when the whole result is empty, under the
				// engine's ungrouped key. Model both so per-group gaps do not read as breaches.
				const groupedAlert = isGroupedPlan(plan) && plan.noDataBehavior === "alert"
				const skipGapsRule: NormalizedRule = {
					...normalized,
					compiledPlan: { ...plan, noDataBehavior: "skip" },
				}
				const emptyKey = toStorageGroupKey(plan, ENGINE_UNGROUPED_GROUP_KEY)
				if (groupedAlert && !obsByGroup.has(emptyKey)) {
					const emptyTicks = pointBuckets.filter(
						(bucketMs) =>
							![...obsByGroup.values()].some(
								(buckets) => buckets.get(bucketMs)?.hasData === true,
							),
					)
					if (emptyTicks.length > 0) obsByGroup.set(emptyKey, new Map())
				}

				const perGroup = yield* Effect.forEach(obsByGroup, ([groupKey, buckets]) =>
					Effect.gen(function* () {
						const isEmptyResultSeries =
							groupedAlert && groupKey === emptyKey && buckets.size === 0
						const tickHasData = (bucketMs: number) =>
							[...obsByGroup.values()].some((other) => other.get(bucketMs)?.hasData === true)
						// Every window in the grid, judged by the same `applyEvaluationLogic`
						// the scheduler runs per tick — no-data windows included, filled from
						// `NO_DATA` so a gap is an evaluated skip rather than a missing point.
						const evaluations = pointBuckets.map((bucketMs) => {
							const obs = buckets.get(bucketMs) ?? NO_DATA
							const evaluation: EvaluatedRule = isEmptyResultSeries
								? tickHasData(bucketMs)
									? // Groups reported this tick: the empty-result incident resolves.
										{
											...applyEvaluationLogic(skipGapsRule, NO_DATA),
											status: "healthy",
											skipReason: undefined,
										}
									: applyEvaluationLogic(normalized, NO_DATA)
								: groupedAlert && !buckets.has(bucketMs)
									? applyEvaluationLogic(skipGapsRule, NO_DATA)
									: applyEvaluationLogic(normalized, obs)
							return {
								bucketMs,
								evaluation,
								sampleCount: obs.sampleCount,
								provisional: hasPartialBucket && bucketMs === endMs,
							}
						})

						const groupSeries = new AlertRulePreviewSeries({
							groupKey,
							points: evaluations.map(({ bucketMs, evaluation, sampleCount, provisional }) => {
								const level = highestBreachedLevel(evaluation.levels)
								return new AlertRulePreviewPoint({
									bucket: iso(bucketMs),
									value: evaluation.value,
									sampleCount,
									status: evaluation.status,
									...(level === null ? undefined : { level }),
									...(evaluation.skipReason === undefined
										? undefined
										: { skipReason: evaluation.skipReason }),
									...(provisional ? { provisional } : undefined),
								})
							}),
						})

						// The would-fire shading is the scheduler's own state machine replayed
						// over the series — not a second implementation of it.
						const spans = yield* simulateFiringSpans(evaluations, normalized, windowMs)
						return {
							series: groupSeries,
							wouldFire: spans.map(
								(span) =>
									new AlertRulePreviewFiringSpan({
										groupKey,
										start: iso(span.startMs),
										end: iso(span.endMs),
										severity: span.severity,
									}),
							),
						}
					}),
				)
				const series = perGroup.map((group) => group.series)
				const wouldFire = perGroup.flatMap((group) => group.wouldFire)

				yield* Effect.annotateCurrentSpan({
					"result.seriesCount": series.length,
					"result.wouldFireCount": wouldFire.length,
				})

				const timing = yield* Fiber.join(queryTiming)
				return new AlertRulePreviewResponse({
					bucketSeconds: windowMs / 1000,
					windowMinutes: normalized.windowMinutes,
					threshold: normalized.threshold,
					thresholdUpper: normalized.thresholdUpper,
					thresholds: normalized.thresholds,
					comparator: normalized.comparator,
					truncatedToStart,
					series,
					wouldFire,
					...(timing === undefined ? undefined : { queryTiming: timing }),
				})
			})

			const claimableDeliveryWhere = (
				$: PG.ColumnAccessor<typeof AlertDeliveryEvents.columns>,
				currentTime: number,
			) =>
				PG.or(
					PG.and($.status.eq("queued"), $.scheduledAt.lte(currentTime)),
					PG.and(
						$.status.eq("processing"),
						$.claimExpiresAt.isNotNull(),
						$.claimExpiresAt.lte(currentTime),
					),
				)

			const claimDeliveryEvent = (deliveryEventId: AlertDeliveryEventRow["id"], currentTime: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(AlertDeliveryEvents)
							.set({
								status: "processing",
								claimedAt: currentTime,
								claimExpiresAt: currentTime + DELIVERY_LEASE_TTL_MS,
								claimedBy: workerId,
								updatedAt: currentTime,
							})
							.where(($) => [$.id.eq(deliveryEventId), claimableDeliveryWhere($, currentTime)])
							.returning("id"),
					),
				)

			const finalizeClaimedDelivery = (
				deliveryEventId: AlertDeliveryEventRow["id"],
				currentTime: number,
				fields: Partial<AlertDeliveryEventRow> & {
					readonly status: "success" | "failed"
				},
			) =>
				dbExecute((db) =>
					db.run(
						PG.update(AlertDeliveryEvents)
							.set({
								...fields,
								claimedAt: null,
								claimExpiresAt: null,
								claimedBy: null,
								updatedAt: currentTime,
							})
							.where(($) => [
								$.id.eq(deliveryEventId),
								$.status.eq("processing"),
								$.claimedBy.eq(workerId),
							]),
					),
				)

			const recordDeliveryFailure = Effect.fn("AlertsService.recordDeliveryFailure")(function* (
				row: AlertDeliveryEventRow,
				currentTime: number,
				failure: DeliveryAttemptFailure,
			) {
				yield* finalizeClaimedDelivery(row.id, currentTime, {
					status: "failed",
					attemptedAt: currentTime,
					errorMessage: failure.message,
				})
				yield* Effect.logWarning("Alert delivery attempt failed").pipe(
					Effect.annotateLogs({
						workerId,
						deliveryKey: row.deliveryKey,
						attemptNumber: row.attemptNumber,
						destinationId: row.destinationId,
						failureKind: failure.kind,
						errorMessage: failure.message,
					}),
				)
			})

			/**
			 * A delivery got through: the destination is alive, so the terminal-failure
			 * streak is over. Guarded on `> 0` so the overwhelmingly common case (a
			 * healthy destination) costs no write.
			 */
			const clearDestinationFailureStreak = Effect.fn("AlertsService.clearDestinationFailureStreak")(
				function* (destinationId: AlertDestinationRow["id"], currentTime: number) {
					yield* dbExecute((db) =>
						db.run(
							PG.update(AlertDestinations)
								.set({
									consecutiveFailures: 0,
									lastFailureAt: null,
									updatedAt: currentTime,
								})
								.where(($) => [$.id.eq(destinationId), $.consecutiveFailures.gte(1)]),
						),
					)
				},
			)

			/**
			 * Count a terminal (`retry: "never"`) failure against the destination and
			 * disable it once the streak reaches the threshold.
			 *
			 * One atomic statement on purpose. Conditioning on `enabled = true` makes
			 * it idempotent against two workers finishing failed deliveries at once —
			 * whoever crosses the threshold second finds `enabled = false` and counts
			 * nothing. Folding the disable into the same statement means a concurrent
			 * success (which zeroes the streak) or an admin repair can never lose to
			 * a stale disable decision taken from a streak that no longer exists.
			 */
			const noteTerminalDestinationFailure = Effect.fn("AlertsService.noteTerminalDestinationFailure")(
				function* (
					row: AlertDeliveryEventRow,
					destinationType: string | null,
					currentTime: number,
					failure: DeliveryAttemptFailure,
				) {
					const reason = failure.message.slice(0, DISABLED_REASON_MAX_LENGTH)
					const counted = yield* dbExecute((db) =>
						db.run(
							PG.update(AlertDestinations)
								.set(($) => {
									const crossesThreshold = $.consecutiveFailures
										.add(1)
										.gte(DESTINATION_DISABLE_AFTER_FAILURES)
									const columns = AlertDestinations.columns
									return {
										consecutiveFailures: $.consecutiveFailures.add(1),
										lastFailureAt: currentTime,
										updatedAt: currentTime,
										enabled: PG.caseWhen(
											[[crossesThreshold, PG.typedValue(columns.enabled, false)]],
											$.enabled,
										),
										disabledAt: PG.caseWhen(
											[
												[
													crossesThreshold,
													PG.typedValue(columns.disabledAt, currentTime),
												],
											],
											$.disabledAt,
										),
										disabledReason: PG.caseWhen(
											[
												[
													crossesThreshold,
													PG.typedValue(columns.disabledReason, reason),
												],
											],
											$.disabledReason,
										),
									}
								})
								.where(($) => [$.id.eq(row.destinationId), $.enabled.eq(true)])
								.returning("consecutiveFailures", "enabled"),
						),
					)

					// None: the `enabled = true` predicate matched no row (already
					// disabled elsewhere) or the update left the destination enabled.
					const disabled = Option.filter(Arr.head(counted), (row) => !row.enabled)
					if (Option.isNone(disabled)) return
					const streak = disabled.value.consecutiveFailures

					// The in-product signal is the setup audit: a disabled destination
					// makes every rule that selects it fail CFG-ALERT-03 ("will evaluate
					// and breach but deliver to nobody"), and `disabledReason` names the
					// provider sentence on the destination itself. There is no org-level
					// notification channel that does not itself go through a destination,
					// so this log is the operator-side signal — same shape as the dead
					// push token path in `MobilePushService`.
					yield* Effect.logWarning(
						"Alert destination auto-disabled after repeated terminal delivery failures",
					).pipe(
						Effect.annotateLogs({
							workerId,
							orgId: row.orgId,
							destinationId: row.destinationId,
							destinationType: destinationType ?? "",
							consecutiveFailures: streak,
							failureKind: failure.kind,
							reason,
						}),
					)
				},
			)

			const processDeliveryBatch = Effect.fn("AlertsService.processDeliveryBatch")(function* (
				deadline: number,
			) {
				const currentTime = yield* now
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertDeliveryEvents)
							.select()
							.where(($) => [claimableDeliveryWhere($, currentTime)])
							.orderBy(["scheduledAt", "asc"])
							.limit(DELIVERY_DRAIN_LIMIT),
					),
				)

				if (rows.length === 0) {
					return {
						claimedCount: 0,
						processedCount: 0,
						failureCount: 0,
					}
				}

				const uniqueDestinationIds = Arr.dedupe(Arr.map(rows, (r) => r.destinationId))
				const uniqueRuleIds = Arr.dedupe(Arr.map(rows, (r) => r.ruleId))
				const uniqueIncidentIds = Arr.dedupe(
					Arr.filterMap(rows, (r) =>
						r.incidentId != null ? Result.succeed(r.incidentId) : Result.failVoid,
					),
				)

				const [allDestinations, allRules, allIncidents] = yield* Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(AlertDestinations)
									.select()
									.where(($) => [$.id.in_(...uniqueDestinationIds)]),
							),
						),
						dbExecute((db) =>
							db.run(selectStoredAlertRules().where(($) => [$.id.in_(...uniqueRuleIds)])),
						),
						uniqueIncidentIds.length > 0
							? dbExecute((db) =>
									db.run(
										PG.from(AlertIncidents)
											.select()
											.where(($) => [$.id.in_(...uniqueIncidentIds)]),
									),
								)
							: Effect.succeed<ReadonlyArray<AlertIncidentRow>>([]),
					],
					{ concurrency: "unbounded" },
				)

				const destinationMap = new Map(allDestinations.map((r) => [r.id, r]))
				const ruleMap = new Map(allRules.map((r) => [r.id, r]))
				const incidentMap = new Map(allIncidents.map((r) => [r.id, r]))

				const processedCount = yield* Ref.make(0)
				const failureCount = yield* Ref.make(0)

				const processOneDelivery = Effect.fn("AlertsService.processOneDelivery")(function* (
					row: AlertDeliveryEventRow,
				) {
					// A fresh read, NOT the batch timestamp: rows run sequentially, so
					// by the time a later row is reached the batch time can be older
					// than DELIVERY_LEASE_TTL_MS — a lease dated from it would be born
					// expired and an overlapping tick could reclaim and re-send the
					// event while this worker is still delivering it.
					const claimTime = yield* now
					const claimed = yield* claimDeliveryEvent(row.id, claimTime)
					if (claimed.length === 0) return

					yield* Ref.update(processedCount, (count) => count + 1)
					yield* Metric.update(AlertingMetrics.deliveriesAttemptedTotal, 1)

					const destinationRow = destinationMap.get(row.destinationId)
					// On the span before anything can fail, so a delivery error issue
					// names the destination it was aimed at without a DB round-trip.
					yield* Effect.annotateCurrentSpan({
						"maple.delivery.destination_id": row.destinationId,
						...(destinationRow
							? { "maple.delivery.destination_type": destinationRow.type }
							: undefined),
					})
					if (!destinationRow) {
						yield* Ref.update(failureCount, (count) => count + 1)
						yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
						yield* recordDeliveryFailure(row, claimTime, {
							message: "Destination not found",
							kind: "destination",
							retryable: false,
						})
						return
					}

					if (!destinationRow.enabled) {
						yield* Ref.update(failureCount, (count) => count + 1)
						yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
						yield* recordDeliveryFailure(row, claimTime, {
							message: "Destination disabled",
							kind: "destination",
							retryable: false,
						})
						return
					}

					const payload = yield* parseDeliveryPayload(row.payloadJson)
					const hydrated = yield* hydrateDestination(destinationRow)
					const incidentRow: AlertIncidentRow | null =
						row.incidentId != null ? (incidentMap.get(row.incidentId) ?? null) : null
					const ruleRow = ruleMap.get(row.ruleId) ?? null
					const payloadRule = payload.rule
					const storedRule = ruleRow ? yield* decodeStoredAlertRuleMetadata(ruleRow) : null
					const groupKey = incidentRow?.groupKey ?? payloadRule?.groupKey ?? null
					const signalType = decodeAlertSignalTypeSync(
						incidentRow?.signalType ?? payloadRule?.signalType ?? "throughput",
					)

					const enrichedSecret = yield* enrichSecretForDispatch(hydrated.row, hydrated.secretConfig)
					const deliveryStart = yield* now
					const result = yield* dispatchDelivery(
						{
							deliveryKey: row.deliveryKey,
							destination: hydrated.row,
							publicConfig: hydrated.publicConfig,
							secretConfig: enrichedSecret,
							ruleId: decodeAlertRuleIdSync(row.ruleId),
							ruleName: ruleRow?.name ?? payloadRule?.name ?? "Alert",
							groupKey,
							signalType,
							// The rule row is the only place the measured quantity is
							// named — the delivery payload carries just the query kind.
							signalDisplay: resolveSignalDisplay({
								signalType,
								queryBuilderDraft: storedRule?.queryBuilderDraft ?? null,
								rawQueryReducer: ruleRow?.reducer ?? null,
							}),
							// The severity the event was raised at, not where the incident
							// has moved since it was queued.
							severity: decodeAlertSeveritySync(
								payloadRule?.severity ?? incidentRow?.severity ?? "warning",
							),
							...(incidentRow?.status === "open"
								? { incidentSeverity: decodeAlertSeveritySync(incidentRow.severity) }
								: undefined),
							...dispatchTierFields(
								payloadRule?.severities,
								payload.peakSeverity ?? null,
								incidentRow?.peakSeverity ?? incidentRow?.severity ?? null,
								ruleRow === null ? Option.none() : yield* storedRuleCondition(ruleRow),
							),
							comparator: decodeAlertComparatorSync(
								incidentRow?.comparator ?? payloadRule?.comparator ?? "gt",
							),
							threshold: incidentRow?.threshold ?? payloadRule?.threshold ?? 0,
							thresholdUpper:
								incidentRow?.thresholdUpper ?? payloadRule?.thresholdUpper ?? null,
							windowMinutes: ruleRow?.windowMinutes ?? payloadRule?.windowMinutes ?? 5,
							eventType: decodeAlertEventTypeSync(row.eventType),
							incidentId: row.incidentId ? decodeAlertIncidentIdSync(row.incidentId) : null,
							incidentStatus: decodeAlertIncidentStatusSync(incidentRow?.status ?? "resolved"),
							dedupeKey: incidentRow?.dedupeKey ?? String(payload.dedupeKey ?? row.deliveryKey),
							value: payload.observed?.value ?? null,
							sampleCount: payload.observed?.sampleCount ?? null,
							detail: payload.observed?.detail ?? null,
							template: payload.template ?? storedRule?.notificationTemplate ?? null,
							sparkline: payload.chart?.sparkline ?? null,
							chartUrl: payload.chart?.url ?? null,
							linkUrl: resolveNotificationLinkUrl(
								{
									serviceNames: storedRule?.serviceNames ?? [],
									groupBy: storedRule?.groupBy ?? null,
								},
								groupKey,
								row.incidentId,
							),
							sentAtMs: deliveryStart,
						},
						JSON.stringify(row.payloadJson),
					)
					yield* Metric.update(
						AlertingMetrics.deliveryAttemptDurationMs,
						(yield* now) - deliveryStart,
					)
					yield* Metric.update(AlertingMetrics.deliveriesSucceededTotal, 1)

					yield* finalizeClaimedDelivery(row.id, claimTime, {
						status: "success",
						attemptedAt: claimTime,
						providerMessage: result.providerMessage,
						providerReference: result.providerReference,
						responseCode: result.responseCode,
						errorMessage: null,
					})

					yield* clearDestinationFailureStreak(row.destinationId, claimTime)

					if (row.incidentId) {
						const incidentId = row.incidentId
						yield* dbExecute((db) =>
							db.run(
								PG.update(AlertIncidents)
									.set({
										lastDeliveredEventType: row.eventType,
										lastNotifiedAt: claimTime,
										updatedAt: claimTime,
									})
									.where(($) => [$.id.eq(incidentId)]),
							),
						)
					}

					yield* Effect.logInfo("Alert delivery attempt succeeded").pipe(
						Effect.annotateLogs({
							workerId,
							deliveryKey: row.deliveryKey,
							attemptNumber: row.attemptNumber,
							destinationId: row.destinationId,
							responseCode: result.responseCode,
						}),
					)
				})

				const recoverDeliveryDefect = Effect.fnUntraced(function* (
					row: AlertDeliveryEventRow,
					defect: unknown,
				) {
					yield* Effect.logError("Alert delivery crashed").pipe(
						Effect.annotateLogs({
							deliveryKey: row.deliveryKey,
							attemptNumber: row.attemptNumber,
							cause: summarizeCause(Cause.die(defect)),
						}),
					)
					// Retried through the bounded attempts, since a crash may be transient
					// and nothing was sent. It is Maple's fault, so the destination's
					// failure streak is left alone. A row whose stored data cannot be
					// read fails its retry insert too, and so is not re-queued.
					yield* recordFailedAttempt(
						row,
						{
							message: "Internal error while delivering this notification",
							kind: "internal",
							retryable: true,
						},
						false,
					)
				})

				const recoverDeliveryFailure = (
					row: AlertDeliveryEventRow,
					error:
						| AlertValidationError
						| AlertDeliveryFailure
						| AlertPersistenceError
						| AlertDestinationStorageError
						| AlertRuleStoredConfigInvalidError,
					// False for all but one row of a digest: one refused post is one destination failure.
					countable = true,
				) => {
					const failure = toDeliveryAttemptFailure(error)
					// Only the provider's own refusal counts: a Maple fault (decryption,
					// stored config, validation, persistence) never disables a destination.
					return recordFailedAttempt(
						row,
						failure,
						countable && !failure.retryable && isProviderDeliveryFailure(error),
					)
				}

				const recordFailedAttempt = Effect.fnUntraced(function* (
					row: AlertDeliveryEventRow,
					failure: DeliveryAttemptFailure,
					countsAgainstDestination: boolean,
				) {
					// Fresh for the same reason as the claim in `processOneDelivery`:
					// retry scheduling from the batch timestamp would date the backoff
					// from before this attempt even started.
					const failedAt = yield* now
					yield* Ref.update(failureCount, (count) => count + 1)
					yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
					yield* finalizeClaimedDelivery(row.id, failedAt, {
						status: "failed",
						attemptedAt: failedAt,
						errorMessage: failure.message,
					})

					const willRetry = canRetryAlertDelivery(row.attemptNumber, failure.retryable)
					if (willRetry) {
						// Carry the original delivery payload through the retry. Empty
						// payloads here would force the next attempt to fall back on
						// rule-row defaults, losing observed value, sample count,
						// dedupe context, and links.
						const retryPayload = yield* parseDeliveryPayload(row.payloadJson).pipe(
							// Validate known fields, but retain the original object so additive
							// payload fields (including the CloudEvent) survive every retry.
							Effect.orElseSucceed(() => ({})),
						)
						yield* insertDeliveryEvent(
							row.orgId,
							row.incidentId,
							row.ruleId,
							row.destinationId,
							decodeAlertEventTypeSync(row.eventType),
							retryPayload,
							failedAt + (yield* computeRetryDelayMs(row.attemptNumber)),
							row.deliveryKey,
							row.attemptNumber + 1,
						)
					}

					// A terminal failure is never retried for this delivery, so without
					// this the destination would keep receiving (and losing) every
					// future incident.
					if (countsAgainstDestination) {
						yield* noteTerminalDestinationFailure(
							row,
							destinationMap.get(row.destinationId)?.type ?? null,
							failedAt,
							failure,
						)
					}

					yield* Effect.logWarning("Alert delivery attempt failed").pipe(
						Effect.annotateLogs({
							workerId,
							deliveryKey: row.deliveryKey,
							attemptNumber: row.attemptNumber,
							destinationId: row.destinationId,
							failureKind: failure.kind,
							errorMessage: failure.message,
							willRetry,
						}),
					)
				})

				const digestItem = Effect.fnUntraced(function* (row: AlertDeliveryEventRow) {
					const incident = row.incidentId != null ? (incidentMap.get(row.incidentId) ?? null) : null
					const ruleRow = ruleMap.get(row.ruleId) ?? null
					// Best effort per line: one unreadable payload must not sink the whole digest.
					const payloadRule = Option.getOrUndefined(
						yield* Effect.option(parseDeliveryPayload(row.payloadJson)),
					)?.rule
					const storedRule =
						ruleRow === null
							? null
							: Option.getOrNull(yield* Effect.option(decodeStoredAlertRuleMetadata(ruleRow)))
					const groupKey = incident?.groupKey ?? payloadRule?.groupKey ?? null
					return {
						ruleName: ruleRow?.name ?? payloadRule?.name ?? "Alert",
						eventType: row.eventType,
						severity: decodeAlertSeveritySync(
							incident?.severity ?? payloadRule?.severity ?? "warning",
						),
						groupKey,
						linkUrl: resolveNotificationLinkUrl(
							{
								serviceNames: storedRule?.serviceNames ?? [],
								groupBy: storedRule?.groupBy ?? null,
							},
							groupKey,
							row.incidentId,
						),
					} satisfies ChatDigestItem
				})

				// One chat message for a burst to one destination; each row still finalizes on its own.
				const processChatDigest = Effect.fn("AlertsService.processChatDigest")(function* (
					destinationRow: AlertDestinationRow,
					group: ReadonlyArray<AlertDeliveryEventRow>,
				) {
					const claimTime = yield* now
					const claimed = (yield* Effect.forEach(group, (row) =>
						claimDeliveryEvent(row.id, claimTime).pipe(
							Effect.map((ids) => (ids.length > 0 ? [row] : [])),
						),
					)).flat()
					if (claimed.length === 0) return
					yield* Ref.update(processedCount, (count) => count + claimed.length)
					yield* Metric.update(AlertingMetrics.deliveriesAttemptedTotal, claimed.length)
					yield* Effect.annotateCurrentSpan({
						"maple.delivery.destination_id": destinationRow.id,
						"maple.delivery.destination_type": "chat",
						"maple.delivery.digest_size": claimed.length,
					})
					yield* Effect.gen(function* () {
						const hydrated = yield* hydrateDestination(destinationRow)
						const config = hydrated.secretConfig
						if (config.type !== "chat")
							return yield* new AlertValidationError({
								message: "Chat destination has a non-chat config",
								details: [],
							})
						const items = yield* Effect.forEach(claimed, digestItem)
						const posted = yield* chatAlertPoster.post({
							orgId: destinationRow.orgId,
							workspaceId: config.workspaceId,
							channelId: config.channelId,
							blocks: buildChatDigestBlocks(items, composeLinkUrl(null), claimTime),
						})
						return { posted, channelName: config.channelName }
					}).pipe(
						Effect.matchEffect({
							onFailure: (error) =>
								Effect.forEach(
									claimed,
									(row, index) =>
										recoverDeliveryFailure(row, error, index === 0).pipe(
											isolate("Alert delivery recovery failed", {
												deliveryKey: row.deliveryKey,
											}),
										),
									{ discard: true },
								),
							onSuccess: ({ posted, channelName }) =>
								finalizeDigest(destinationRow, claimed, claimTime, {
									providerMessage: `Delivered to ${posted.connectorName} #${channelName} in a digest of ${claimed.length}`,
									providerReference: posted.messageId,
								}),
						}),
						Effect.catchDefect((defect) =>
							Effect.forEach(
								claimed,
								(row) =>
									recoverDeliveryDefect(row, defect).pipe(
										isolate("Alert delivery recovery failed", {
											deliveryKey: row.deliveryKey,
										}),
									),
								{ discard: true },
							),
						),
					)
				})

				const finalizeDigest = Effect.fnUntraced(function* (
					destinationRow: AlertDestinationRow,
					claimed: ReadonlyArray<AlertDeliveryEventRow>,
					claimTime: number,
					result: { readonly providerMessage: string; readonly providerReference: string },
				) {
					yield* Metric.update(AlertingMetrics.deliveriesSucceededTotal, claimed.length)
					yield* Effect.forEach(
						claimed,
						(row) =>
							Effect.gen(function* () {
								yield* finalizeClaimedDelivery(row.id, claimTime, {
									status: "success",
									attemptedAt: claimTime,
									providerMessage: result.providerMessage,
									providerReference: result.providerReference,
									responseCode: null,
									errorMessage: null,
								})
								const incidentId = row.incidentId
								if (incidentId === null) return
								yield* dbExecute((db) =>
									db.run(
										PG.update(AlertIncidents)
											.set({
												lastDeliveredEventType: row.eventType,
												lastNotifiedAt: claimTime,
												updatedAt: claimTime,
											})
											.where(($) => [$.id.eq(incidentId)]),
									),
								)
							}),
						{ discard: true },
					)
					yield* clearDestinationFailureStreak(destinationRow.id, claimTime)
				})

				// Bursts of more than CHAT_DIGEST_THRESHOLD for one enabled chat destination.
				const digestGroups = Object.values(
					Arr.groupBy(
						rows.filter(
							(row) =>
								row.eventType !== "test" &&
								destinationMap.get(row.destinationId)?.type === "chat" &&
								destinationMap.get(row.destinationId)?.enabled === true,
						),
						(row) => row.destinationId,
					),
				).filter((group) => group.length > CHAT_DIGEST_THRESHOLD)
				// Each row maps to its digest; the digest goes out where its first row sits in batch order.
				const digestOf = new Map(
					digestGroups.flatMap((group) => group.map((row) => [row.id, group] as const)),
				)

				const deliverRow = (row: AlertDeliveryEventRow) => {
					const group = digestOf.get(row.id)
					if (group !== undefined) {
						const destinationRow = destinationMap.get(row.destinationId)
						return group[0].id !== row.id || destinationRow === undefined
							? Effect.void
							: processChatDigest(destinationRow, group).pipe(
									isolate("Alert digest delivery failed", {
										destinationId: destinationRow.id,
									}),
								)
					}
					return processOneDelivery(row).pipe(
						Effect.catch((error) => recoverDeliveryFailure(row, error)),
						// A crash finalizes the row, so it cannot be re-claimed first on
						// every tick and stall the queue behind it.
						Effect.catchDefect((defect) => recoverDeliveryDefect(row, defect)),
						isolate("Alert delivery recovery failed", { deliveryKey: row.deliveryKey }),
					)
				}

				// Serial within a destination (its failure streak and ordering), parallel
				// across them, so one dead webhook costs its own rows and not every org's.
				// The budget is checked per row: a row past it is left unclaimed for the
				// next tick rather than started.
				yield* Effect.forEach(
					Object.values(Arr.groupBy(rows, (row) => row.destinationId)),
					(destinationRows) =>
						Effect.forEach(
							destinationRows,
							(row) =>
								Effect.flatMap(now, (time) =>
									time < deadline ? deliverRow(row) : Effect.void,
								),
							{ discard: true },
						),
					{ concurrency: DELIVERY_DESTINATION_CONCURRENCY, discard: true },
				)

				return {
					claimedCount: rows.length,
					processedCount: yield* Ref.get(processedCount),
					failureCount: yield* Ref.get(failureCount),
				}
			})

			// Batches until the queue is drained or the budget is spent, so a burst
			// larger than one batch does not build a backlog across ticks.
			const processQueuedDeliveries = Effect.fn("AlertsService.processQueuedDeliveries")(function* () {
				const deadline = (yield* now) + DELIVERY_DRAIN_BUDGET_MS
				const totals = yield* Ref.make({ processedCount: 0, failureCount: 0 })
				yield* processDeliveryBatch(deadline).pipe(
					Effect.tap((batch) =>
						Ref.update(totals, (sum) => ({
							processedCount: sum.processedCount + batch.processedCount,
							failureCount: sum.failureCount + batch.failureCount,
						})),
					),
					Effect.flatMap((batch) =>
						Effect.map(
							now,
							(time) => batch.claimedCount === DELIVERY_DRAIN_LIMIT && time < deadline,
						),
					),
					Effect.repeat({ while: (more) => more }),
				)
				return yield* Ref.get(totals)
			})

			// Investigation starts the rule loop queued, run once every rule's claim-fenced
			// writes are done and the claims are released, so a slow model call holds no
			// claim. None is dropped: incidents open once, so a skipped start never retries.
			const startPendingTriages = Effect.fn("AlertsService.startPendingTriages")(function* (
				pending: ReadonlyArray<MaybeEnqueueTriageInput>,
			) {
				yield* Effect.annotateCurrentSpan("maple.alerting.triages_pending", pending.length)
				// One admission permit per org keeps the daily quota exact under concurrency.
				const admissions = new Map(
					yield* Effect.forEach(Arr.dedupe(Arr.map(pending, (triage) => triage.orgId)), (orgId) =>
						Effect.map(Semaphore.make(1), (admission) => [orgId, admission] as const),
					),
				)
				yield* Effect.forEach(
					pending,
					(triage) =>
						maybeEnqueueTriage({
							...triage,
							chatSessions,
							admission: admissions.get(triage.orgId),
						}).pipe(Effect.provideService(Database, database)),
					{ concurrency: TRIAGE_START_CONCURRENCY, discard: true },
				)
			})

			const processEvaluation = Effect.fn("AlertsService.processEvaluation")(function* (
				row: StoredAlertRuleRow,
				normalized: NormalizedRule,
				evaluation: EvaluatedRule,
				groupKey: string,
				timestamp: number,
				pendingChecks: Ref.Ref<Chunk.Chunk<AlertChecksRow>>,
				issueBudget: Ref.Ref<number>,
				pendingTriages: Ref.Ref<Chunk.Chunk<MaybeEnqueueTriageInput>>,
				pushBudget: IncidentPushBudget,
				prefetch: TickPrefetch,
				stateWrites: RuleStateWrites,
				windowEndMs: number,
			) {
				// `timestamp` is the tick's claim on the rule. The claim can expire while
				// this runs (slow notification enrichment, a late warehouse result), so
				// every state and incident write goes through `writeUnderClaim`: once a
				// later tick re-claims the rule, the next write fails with
				// AlertRuleClaimLostError and the rest of the rule is left to that tick.
				// Slow notification reads happen before or after a write, never inside it.
				const claim: RuleClaim = {
					ruleId: row.id,
					claimedAt: timestamp,
					ruleUpdatedAt: row.updatedAt,
				}
				const evaluateTransition = Effect.fnUntraced(function* () {
					// Both reads come from the tick-head prefetch rather than a query per
					// group. Safe because this function is the only writer of either key
					// and runs at most once per key per tick — see `loadTickPrefetch`.
					const state = prefetch.stateFor(row.orgId, row.id, groupKey)

					// The open incident for this group, via the unique
					// (orgId, ruleId, status, groupKey) combination. Composite group
					// keys make serviceName ambiguous, so groupKey is authoritative.
					const openIncident = prefetch.openIncidentFor(row.orgId, row.id, groupKey)

					// Default for check-history ingest: carry open-incident linkage (if any),
					// transition remains "none" unless a branch below overrides it.
					const carriedIncidentId = openIncident?.id ?? null

					// `alert_rule_states` is Electric-synced: every write advances the shape
					// log and wakes every connected client's live long-poll. Unchanged-state
					// ticks therefore skip the upsert entirely, refreshing lastEvaluatedAt at
					// most every STATE_HEARTBEAT_MS. The equality gate deliberately ignores
					// lastValue/lastSampleCount — they float every tick for real metrics and
					// nothing downstream reads their freshness (the web client and listRules
					// consume only lastError + lastEvaluatedAt from this table); they catch up
					// on every transition/heartbeat write.
					const upsertState = (
						fields: {
							consecutiveBreaches: number
							consecutiveHealthy: number
							historyJson: ReadonlyArray<number>
							lastStatus: string
							lastValue: number | null
							lastSampleCount: number
						},
						deferred: boolean,
					) => {
						const unchanged =
							state != null &&
							state.consecutiveBreaches === fields.consecutiveBreaches &&
							state.consecutiveHealthy === fields.consecutiveHealthy &&
							state.historyJson !== null &&
							state.historyJson.length === fields.historyJson.length &&
							state.historyJson.every((code, index) => code === fields.historyJson[index]) &&
							state.lastStatus === fields.lastStatus &&
							state.lastError == null &&
							state.lastEvaluatedAt != null &&
							timestamp - state.lastEvaluatedAt < STATE_HEARTBEAT_MS
						if (unchanged) return Effect.void
						const stateRow: AlertRuleStateRow = {
							orgId: row.orgId,
							ruleId: row.id,
							groupKey,
							...fields,
							lastEvaluatedAt: timestamp,
							lastError: null,
							lastErrorKind: null,
							updatedAt: timestamp,
						}
						if (deferred)
							return Ref.update(stateWrites, (buffer) => ({
								...buffer,
								rows: HashMap.set(buffer.rows, groupKey, stateRow),
							}))
						return writeUnderClaim(claim, (db) =>
							db.run(
								PG.insertInto(AlertRuleStates)
									.values(stateRow)
									.onConflictDoUpdate({
										target: ["orgId", "ruleId", "groupKey"],
										set: {
											...fields,
											lastEvaluatedAt: timestamp,
											lastError: null,
											lastErrorKind: null,
											updatedAt: timestamp,
										},
									}),
							),
						)
					}

					const lifecycleInput: AlertLifecycleInput = {
						policy: {
							consecutiveBreachesRequired: normalized.consecutiveBreachesRequired,
							breachWindow: normalized.breachesOutOf ?? normalized.consecutiveBreachesRequired,
							consecutiveHealthyRequired: normalized.consecutiveHealthyRequired,
							renotifyIntervalMinutes: normalized.renotifyIntervalMinutes,
							severities: normalized.thresholds.map((tier) => tier.severity),
						},
						evaluation,
						state:
							state == null
								? null
								: {
										consecutiveBreaches: state.consecutiveBreaches,
										consecutiveHealthy: state.consecutiveHealthy,
										history: state.historyJson,
									},
						openIncident:
							openIncident == null
								? null
								: {
										severity: decodeAlertSeveritySync(openIncident.severity),
										firstTriggeredAtMs: openIncident.firstTriggeredAt,
										lastNotifiedAtMs: openIncident.lastNotifiedAt,
										lastDeliveredEventType:
											openIncident.lastDeliveredEventType == null
												? null
												: decodeAlertEventTypeSync(
														openIncident.lastDeliveredEventType,
													),
									},
						nowMs: timestamp,
					}

					let lifecycle = yield* planAlertLifecycle(lifecycleInput)
					// Persist the counter/state decision before follow-up adapter work, as
					// before extraction. A failed flap-history or liveness query must not
					// discard an evaluation that already completed successfully.
					// A group with no incident or hold work only changes its state row,
					// so that row joins the rule's batched upsert. Any other group still
					// writes it inline, before its incident write, as before.
					yield* upsertState(
						{
							consecutiveBreaches: lifecycle.state.consecutiveBreaches,
							consecutiveHealthy: lifecycle.state.consecutiveHealthy,
							historyJson: lifecycle.state.history,
							lastStatus: evaluation.status,
							lastValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
						},
						lifecycle.transition === "none" && lifecycle.hold === null,
					)

					// Ask the persistence adapter for flap history only when the pure core
					// has decided that a new incident is otherwise ready to open.
					if (lifecycle.transition === "opened") {
						const priorNotified =
							(yield* dbExecute((db) =>
								db.run(
									PG.from(AlertIncidents)
										.select("lastNotifiedAt")
										.where(($) => [
											$.orgId.eq(row.orgId),
											$.ruleId.eq(row.id),
											$.groupKey.eq(groupKey),
											$.status.eq("resolved"),
											$.lastNotifiedAt.isNotNull(),
											$.lastNotifiedAt.gte(
												timestamp - normalized.renotifyIntervalMinutes * 60_000,
											),
										])
										.orderBy(["lastNotifiedAt", "desc"])
										.limit(1),
								),
							))[0] ?? null
						lifecycle = yield* planAlertLifecycle({
							...lifecycleInput,
							previousNotificationAtMs: priorNotified?.lastNotifiedAt ?? null,
						})
					}

					// The core requests a liveness decision for an empty skipped window
					// or a synthesized healthy value. The host owns the durable hold
					// clock and reason-specific ceilings.
					let resolveEvaluation = evaluation
					let heldForMs = openIncident?.heldSince == null ? 0 : timestamp - openIncident.heldSince
					if (lifecycle.hold === "missing_telemetry" && openIncident != null) {
						const liveness = yield* telemetryStillFlowing(
							row.orgId,
							normalized,
							openIncident.firstTriggeredAt,
							timestamp,
							livenessServicesForIncident(normalized, groupKey),
						)
						const gate = decideLivenessGate(
							openIncident,
							liveness,
							normalized.windowMinutes,
							timestamp,
						)
						if (gate.kind === "hold") {
							yield* recordHold(openIncident, gate, liveness, timestamp, claim)
						} else {
							heldForMs = gate.heldForMs
							resolveEvaluation =
								evaluation.skipReason === "no_data"
									? makeSyntheticResolveEvaluation(
											normalized,
											gate.reason ??
												"Auto-resolved: no data for this group while telemetry kept flowing",
										)
									: gate.reason === null
										? evaluation
										: { ...evaluation, reason: gate.reason }
							lifecycle = yield* planAlertLifecycle({
								...lifecycleInput,
								allowNoDataResolution: true,
							})
						}
					}

					if (lifecycle.transition === "opened") {
						const incidentId = decodeAlertIncidentIdSync(makeUuid())
						const inheritedNotificationAt = lifecycle.inheritedNotificationAtMs ?? null
						const openedRule = ruleAtSeverity(
							normalized,
							lifecycle.severity ?? normalized.severity,
						)
						const incident: AlertIncidentRow = {
							id: incidentId,
							orgId: row.orgId,
							ruleId: row.id,
							incidentKey: incidentId,
							ruleName: row.name,
							groupKey,
							signalType: normalized.signalType,
							severity: openedRule.severity,
							peakSeverity: openedRule.severity,
							status: "open",
							comparator: normalized.comparator,
							threshold: openedRule.threshold,
							thresholdUpper: openedRule.thresholdUpper,
							firstTriggeredAt: timestamp,
							lastTriggeredAt: timestamp,
							resolvedAt: null,
							lastObservedValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
							lastEvaluatedAt: timestamp,
							dedupeKey: `${row.orgId}:${row.id}:${groupKey}`,
							lastDeliveredEventType: null,
							lastNotifiedAt: inheritedNotificationAt,
							holdReason: null,
							heldSince: null,
							errorIssueId: null,
							createdAt: timestamp,
							updatedAt: timestamp,
						}

						// The trigger's delivery rows commit with the incident. Queued after
						// it, a failure in between left an open incident that never paged:
						// the next tick sees it open and plans `continued`. Prepared first so
						// the slow reads stay outside the claim lock; a failure here leaves
						// nothing open, and the next tick opens it again.
						const deliveries =
							lifecycle.notificationSuppression !== "flapping" &&
							lifecycle.eventType === "trigger"
								? yield* prepareIncidentDeliveries(
										row.orgId,
										openedRule,
										incident,
										evaluation,
										"trigger",
										timestamp,
									)
								: []

						// `alert_incidents_open_group_idx` allows one open incident per
						// (org, rule, group). `writeUnderClaim` stops a tick whose claim
						// expired; this is the backstop for the tick that re-claimed it,
						// whose tick-head prefetch can predate the open. The loser lands
						// here and must not notify.
						const inserted = yield* writeUnderClaim(claim, (db) =>
							db
								.run(
									PG.insertInto(AlertIncidents)
										.values(incident)
										.onConflictDoNothing()
										.returning("id"),
								)
								.pipe(
									Effect.tap((rows) =>
										rows.length === 0
											? Effect.void
											: insertIncidentDeliveries(db, deliveries),
									),
								),
						)
						if (inserted.length === 0) {
							yield* Effect.logWarning(
								"Skipped duplicate incident open: another worker won the race",
							).pipe(Effect.annotateLogs({ ruleId: row.id, groupKey }))
							return {
								transition: "none" as const,
								incidentId: carriedIncidentId,
								openedIncidentId: null,
								consecutiveBreaches: lifecycle.state.consecutiveBreaches,
								consecutiveHealthy: lifecycle.state.consecutiveHealthy,
								severity: lifecycle.severity,
							}
						}
						yield* syncStatusPages(
							normalized.signalType,
							{ orgId: row.orgId, alertIncidentId: incidentId },
							(db) =>
								openForAlertIncident(db, {
									orgId: row.orgId,
									ruleId: row.id,
									alertIncidentId: incidentId,
									at: timestamp,
								}),
						)
						if (lifecycle.notificationSuppression === "flapping") {
							yield* Effect.logInfo("Skipping trigger notification for flapping incident").pipe(
								Effect.annotateLogs({
									ruleId: row.id,
									incidentId,
									groupKey,
									priorNotifiedAt:
										inheritedNotificationAt === null
											? undefined
											: new Date(inheritedNotificationAt).toISOString(),
								}),
							)
						} else if (lifecycle.eventType === "trigger") {
							yield* pushIncidentNotification(
								row.orgId,
								openedRule,
								incident,
								evaluation,
								lifecycle.eventType,
								timestamp,
								pushBudget,
								null,
							)
						}
						return {
							transition: lifecycle.transition,
							incidentId,
							openedIncidentId: incidentId,
							consecutiveBreaches: lifecycle.state.consecutiveBreaches,
							consecutiveHealthy: lifecycle.state.consecutiveHealthy,
							severity: lifecycle.severity,
						}
					}

					const severityChanged =
						lifecycle.transition === "escalated" || lifecycle.transition === "deescalated"
					if ((lifecycle.transition === "continued" || severityChanged) && openIncident != null) {
						const severity = lifecycle.severity ?? decodeAlertSeveritySync(openIncident.severity)
						const peakSeverity = maxSeverity(
							severity,
							decodeAlertSeveritySync(openIncident.peakSeverity ?? openIncident.severity),
						)
						// A severity change reaches everyone notified so far; a reminder only the current tier.
						const tierRule = ruleAtSeverity(
							normalized,
							severity,
							severityChanged ? peakSeverity : null,
						)
						const refreshedIncident = {
							...openIncident,
							severity,
							peakSeverity,
							threshold: tierRule.threshold,
							thresholdUpper: tierRule.thresholdUpper,
							lastTriggeredAt: timestamp,
							lastObservedValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
							lastEvaluatedAt: timestamp,
							holdReason: null,
							heldSince: null,
							updatedAt: timestamp,
						}
						// `status = 'open'` plus RETURNING: the prefetch can predate a resolve
						// by a tick that held this rule before us, and a resolved incident
						// must not be refreshed or renotified.
						const refreshed = yield* writeUnderClaim(claim, (db) =>
							db.run(
								PG.update(AlertIncidents)
									.set({
										// A rule edit can remap the severity without a transition.
										...(severity !== openIncident.severity
											? {
													severity,
													peakSeverity,
													threshold: tierRule.threshold,
													thresholdUpper: tierRule.thresholdUpper,
												}
											: undefined),
										lastTriggeredAt: timestamp,
										lastObservedValue: evaluation.value,
										lastSampleCount: evaluation.sampleCount,
										lastEvaluatedAt: timestamp,
										holdReason: null,
										heldSince: null,
										updatedAt: timestamp,
										lastNotifiedAt: lifecycle.advanceNotificationAnchor
											? timestamp
											: openIncident.lastNotifiedAt,
									})
									.where(($) => [$.id.eq(openIncident.id), $.status.eq("open")])
									.returning("id"),
							),
						)
						if (refreshed.length === 0) {
							return {
								transition: "none" as const,
								incidentId: null,
								openedIncidentId: null,
								consecutiveBreaches: lifecycle.state.consecutiveBreaches,
								consecutiveHealthy: lifecycle.state.consecutiveHealthy,
								severity: lifecycle.severity,
							}
						}
						if (lifecycle.eventType === "renotify" || lifecycle.eventType === "trigger") {
							yield* queueIncidentNotifications(
								row.orgId,
								tierRule,
								refreshedIncident,
								evaluation,
								lifecycle.eventType,
								timestamp,
								pushBudget,
							)
						}
						return {
							transition: lifecycle.transition,
							incidentId: openIncident.id,
							openedIncidentId: null,
							consecutiveBreaches: lifecycle.state.consecutiveBreaches,
							consecutiveHealthy: lifecycle.state.consecutiveHealthy,
							severity: lifecycle.severity,
						}
					}

					if (lifecycle.transition === "resolved" && openIncident != null) {
						const resolvedIncident = {
							...openIncident,
							status: "resolved" as const,
							resolvedAt: timestamp,
							lastObservedValue: resolveEvaluation.value,
							lastSampleCount: resolveEvaluation.sampleCount,
							lastEvaluatedAt: timestamp,
							holdReason: null,
							heldSince: null,
							updatedAt: timestamp,
						}
						// Same `status = 'open'` guard as above: only the write that actually
						// resolves the incident sends the resolve notification.
						const resolved = yield* writeUnderClaim(claim, (db) =>
							db.run(
								PG.update(AlertIncidents)
									.set({
										status: "resolved",
										resolvedAt: timestamp,
										lastObservedValue: resolveEvaluation.value,
										lastSampleCount: resolveEvaluation.sampleCount,
										lastEvaluatedAt: timestamp,
										holdReason: null,
										heldSince: null,
										updatedAt: timestamp,
									})
									.where(($) => [$.id.eq(openIncident.id), $.status.eq("open")])
									.returning("id"),
							),
						)
						if (resolved.length === 0) {
							return {
								transition: "none" as const,
								incidentId: null,
								openedIncidentId: null,
								consecutiveBreaches: lifecycle.state.consecutiveBreaches,
								consecutiveHealthy: lifecycle.state.consecutiveHealthy,
								severity: lifecycle.severity,
							}
						}
						yield* syncStatusPages(
							normalized.signalType,
							{ orgId: row.orgId, alertIncidentId: openIncident.id },
							(db) =>
								resolveForAlertIncident(db, {
									orgId: row.orgId,
									alertIncidentId: openIncident.id,
									at: timestamp,
								}),
						)
						if (openIncident.holdReason !== null) {
							yield* Metric.update(AlertingMetrics.incidentsResolvedAfterHoldTotal, 1)
						}
						if (lifecycle.notificationSuppression === "flap_resolution") {
							yield* Effect.logInfo("Skipping resolve notification for flapping incident").pipe(
								Effect.annotateLogs({
									ruleId: row.id,
									incidentId: openIncident.id,
									groupKey,
								}),
							)
						} else if (lifecycle.eventType === "resolve") {
							yield* queueIncidentNotifications(
								row.orgId,
								ruleForResolve(normalized, openIncident),
								resolvedIncident,
								resolveEvaluation,
								lifecycle.eventType,
								timestamp,
								pushBudget,
								afterHold(openIncident, heldForMs),
							)
						}
						return {
							transition: lifecycle.transition,
							incidentId: openIncident.id,
							openedIncidentId: null,
							consecutiveBreaches: lifecycle.state.consecutiveBreaches,
							consecutiveHealthy: lifecycle.state.consecutiveHealthy,
							severity: lifecycle.severity,
						}
					}

					return {
						transition: lifecycle.transition,
						incidentId: carriedIncidentId,
						openedIncidentId: null,
						consecutiveBreaches: lifecycle.state.consecutiveBreaches,
						consecutiveHealthy: lifecycle.state.consecutiveHealthy,
						severity: lifecycle.severity,
					}
				})
				const outcome = yield* evaluateTransition()

				if (outcome.transition === "opened") {
					yield* Metric.update(AlertingMetrics.incidentsOpenedTotal, 1)
				}
				if (outcome.transition === "resolved") {
					yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, 1)
				}
				if (outcome.transition === "escalated" && outcome.severity === "critical") {
					yield* escalateAlertIssue({
						orgId: row.orgId,
						ruleId: row.id,
						groupKey,
						timestamp,
					}).pipe(Effect.provideService(Database, database))
				}

				// Issue-hub: a freshly opened incident creates/refreshes its issue
				// (kind="alert") so it lands in the unified triage queue. Budgeted per
				// tick as a storm fuse for pathological group-by rules; upsertAlertIssue
				// never fails, so the scheduler tick is isolated from issue problems.
				if (outcome.openedIncidentId != null) {
					const incidentId = outcome.openedIncidentId
					const allowed = yield* Ref.modify(issueBudget, (remaining): [boolean, number] =>
						remaining > 0 ? [true, remaining - 1] : [false, remaining],
					)
					if (allowed) {
						// The tier the incident opened at, so severity and threshold agree.
						const openedRule = ruleAtSeverity(normalized, outcome.severity ?? normalized.severity)
						const linked = yield* upsertAlertIssue({
							orgId: row.orgId,
							ruleId: row.id,
							ruleName: row.name,
							groupKey,
							signalType: normalized.signalType,
							severity: openedRule.severity,
							comparator: normalized.comparator,
							threshold: openedRule.threshold,
							thresholdUpper: openedRule.thresholdUpper,
							windowMinutes: normalized.windowMinutes,
							observedValue: evaluation.value,
							sampleCount: evaluation.sampleCount,
							incidentId,
							serviceName:
								normalized.groupBy?.[0] === "service.name"
									? groupKey
									: (normalized.serviceNames[0] ?? ""),
							timestamp,
						}).pipe(Effect.provideService(Database, database))
						// Started after the rule loop (`startPendingTriages`), off this rule's claim.
						if (linked.triage !== null) {
							yield* Ref.update(pendingTriages, Chunk.append(linked.triage))
						}
					} else {
						yield* Effect.logWarning(
							"Alert issue upsert budget exhausted; skipping issue link",
						).pipe(Effect.annotateLogs({ ruleId: row.id, incidentId, groupKey }))
					}
				}

				// Record one audit row per evaluation to the Tinybird alert_checks datasource.
				const evaluationEndMs = yield* now
				const checkRow: AlertChecksRow = {
					OrgId: row.orgId,
					RuleId: row.id,
					GroupKey: groupKey,
					Timestamp: toIngestDateTime64(timestamp),
					Status: evaluation.status,
					SkipReason: evaluation.skipReason ?? "",
					SignalType: normalized.signalType,
					Comparator: normalized.comparator,
					Threshold: normalized.threshold,
					ObservedValue: evaluation.value,
					SampleCount: evaluation.sampleCount,
					WindowMinutes: normalized.windowMinutes,
					// The window the tick read, not the claim time: the claim lands later in the spread.
					WindowStart: toIngestDateTime64(windowEndMs - normalized.windowMinutes * 60_000),
					WindowEnd: toIngestDateTime64(windowEndMs),
					ConsecutiveBreaches: outcome.consecutiveBreaches,
					ConsecutiveHealthy: outcome.consecutiveHealthy,
					IncidentId: outcome.incidentId,
					// The checks API (and the iOS client) decode a closed set; a severity
					// change is a continuing incident there, and `Level` says which tier.
					IncidentTransition:
						outcome.transition === "escalated" || outcome.transition === "deescalated"
							? "continued"
							: outcome.transition,
					Level: highestBreachedLevel(evaluation.levels) ?? "",
					EvaluationDurationMs: Math.max(0, evaluationEndMs - timestamp),
					ErrorMessage: null,
					ErrorCategory: "",
				}
				// Buffer instead of POSTing per-evaluation; the scheduler tick flushes
				// all rows once at the end (one POST per orgId). Awaited flush keeps
				// the Cloudflare Worker isolate alive across the batch write.
				// A group whose state row is still buffered reports its check only once
				// `flushRuleStates` commits that row.
				const staged = yield* Ref.modify(stateWrites, (buffer) =>
					HashMap.has(buffer.rows, groupKey)
						? [true, { ...buffer, checks: Chunk.append(buffer.checks, checkRow) }]
						: [false, buffer],
				)
				if (!staged) yield* Ref.update(pendingChecks, Chunk.append(checkRow))
			})

			/* -------------------------------------------------------------------------- */
			/*  Stale incident resolution                                               */
			/* -------------------------------------------------------------------------- */

			const computeStaleGroupKeys = (
				oldRule: NormalizedRule,
				newRule: NormalizedRule,
			): HashSet.HashSet<string> => {
				const removedServices = HashSet.difference(
					HashSet.fromIterable(oldRule.serviceNames),
					HashSet.fromIterable(newRule.serviceNames),
				)
				const newlyExcluded = HashSet.difference(
					HashSet.fromIterable(newRule.excludeServiceNames),
					HashSet.fromIterable(oldRule.excludeServiceNames),
				)
				return HashSet.union(removedServices, newlyExcluded)
			}

			const groupByEqual = (
				a: ReadonlyArray<string> | null,
				b: ReadonlyArray<string> | null,
			): boolean => {
				if (a == null || b == null) return a == null && b == null
				if (a.length !== b.length) return false
				for (let i = 0; i < a.length; i++) {
					if (a[i] !== b[i]) return false
				}
				return true
			}

			/**
			 * The user-facing grouping keys a rule evaluates by — rule-level groupBy,
			 * or the builder draft's groupBy for builder_query rules (which always
			 * persist rule-level groupBy as null). Compared at key level because
			 * different attribute keys (attr.http.route vs attr.http.method) compile
			 * to the same spec token ("attribute").
			 */
			const effectiveGroupByKeys = (rule: NormalizedRule): ReadonlyArray<string> | null => {
				if (rule.groupBy != null && rule.groupBy.length > 0) return rule.groupBy
				const draft = rule.queryBuilderDraft
				if (
					rule.signalType === "builder_query" &&
					draft?.addOns?.groupBy === true &&
					draft.groupBy != null &&
					draft.groupBy.length > 0
				) {
					return draft.groupBy
				}
				return null
			}

			const ruleStructureChanged = (oldRule: NormalizedRule, newRule: NormalizedRule): boolean => {
				if (!groupByEqual(effectiveGroupByKeys(oldRule), effectiveGroupByKeys(newRule))) return true
				if (oldRule.signalType !== newRule.signalType) return true
				// An incident opened on an empty window cannot resolve once empty windows are skipped again.
				if (oldRule.compiledPlan.noDataBehavior !== newRule.compiledPlan.noDataBehavior) return true
				const mode = (r: NormalizedRule) =>
					isGroupedPlan(r.compiledPlan) ? "grouped" : r.serviceNames.length > 1 ? "multi" : "single"
				return mode(oldRule) !== mode(newRule)
			}

			const makeSyntheticResolveEvaluation = (
				normalized: NormalizedRule,
				reason: string,
			): EvaluatedRule => ({
				status: "healthy",
				value: null,
				sampleCount: 0,
				threshold: normalized.threshold,
				thresholdUpper: normalized.thresholdUpper,
				comparator: normalized.comparator,
				levels: normalized.thresholds.map((tier) => ({ severity: tier.severity, status: "clear" })),
				reason,
				// This "healthy" is fabricated for config-driven resolves (rule changed,
				// group vanished), not derived from an empty query window. Callers that
				// resolve on absence gate themselves — see resolveOrphanedGroupIncidents.
				derivedFromNoData: false,
			})

			const resolveStaleIncidents = Effect.fn("AlertsService.resolveStaleIncidents")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				normalized: NormalizedRule,
				opts: {
					readonly staleGroupKeys?: HashSet.HashSet<string>
					readonly resolveAll?: boolean
					/** Absent on the rule-edit paths, which are one user action. */
					readonly pushBudget?: IncidentPushBudget
				},
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
				const openIncidents = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertIncidents)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.ruleId.eq(ruleId), $.status.eq("open")]),
					),
				)

				const toResolve = opts.resolveAll
					? openIncidents
					: Arr.filter(
							openIncidents,
							(i) =>
								i.groupKey != null &&
								(opts.staleGroupKeys ? HashSet.has(opts.staleGroupKeys, i.groupKey) : false),
						)

				if (toResolve.length === 0) return

				const timestamp = yield* now
				const syntheticEvaluation = makeSyntheticResolveEvaluation(
					normalized,
					"Auto-resolved: rule configuration changed",
				)
				const staleGroupKeys = Arr.map(toResolve, (i) => i.groupKey ?? UNGROUPED_GROUP_KEY)

				// Same guards as resolveOrphanedGroupIncidents: `status = 'open'` plus
				// RETURNING skips an incident resolved since the select (no second
				// all-clear), and a flap-suppressed incident gets no resolve notification.
				const resolveOutcomes = yield* Effect.forEach(toResolve, (incident) =>
					Effect.gen(function* () {
						// A hold is a sub-state of open; a config-driven resolve ends it too.
						const resolved = yield* dbExecute((db) =>
							db.run(
								PG.update(AlertIncidents)
									.set({
										status: "resolved",
										resolvedAt: timestamp,
										holdReason: null,
										heldSince: null,
										updatedAt: timestamp,
									})
									.where(($) => [$.id.eq(incident.id), $.status.eq("open")])
									.returning("id"),
							),
						)
						if (resolved.length === 0) return false
						yield* syncStatusPages(
							normalized.signalType,
							{ orgId, alertIncidentId: incident.id },
							(db) =>
								resolveForAlertIncident(db, {
									orgId,
									alertIncidentId: incident.id,
									at: timestamp,
								}),
						)
						if (incident.holdReason !== null) {
							yield* Metric.update(AlertingMetrics.incidentsResolvedAfterHoldTotal, 1)
						}

						if (incident.lastDeliveredEventType == null && incident.lastNotifiedAt != null) {
							yield* Effect.logInfo("Skipping resolve notification for flapping incident").pipe(
								Effect.annotateLogs({ ruleId, incidentId: incident.id }),
							)
							return true
						}
						// A held incident resolved by a rule edit still tells the phone it
						// was waiting on data, not that a value recovered.
						const heldForMs = incident.heldSince === null ? 0 : timestamp - incident.heldSince
						yield* queueIncidentNotifications(
							orgId,
							ruleForResolve(normalized, incident),
							{
								...incident,
								status: "resolved",
								resolvedAt: timestamp,
								holdReason: null,
								heldSince: null,
								updatedAt: timestamp,
							},
							syntheticEvaluation,
							"resolve",
							timestamp,
							opts.pushBudget ?? null,
							afterHold(incident, heldForMs),
						)
						return true
					}),
				)

				if (opts.resolveAll) {
					yield* dbExecute((db) =>
						db.run(
							PG.deleteFrom(AlertRuleStates).where(($) => [
								$.orgId.eq(orgId),
								$.ruleId.eq(ruleId),
							]),
						),
					)
				} else if (staleGroupKeys.length > 0) {
					yield* dbExecute((db) =>
						db.run(
							PG.deleteFrom(AlertRuleStates).where(($) => [
								$.orgId.eq(orgId),
								$.ruleId.eq(ruleId),
								$.groupKey.in_(...staleGroupKeys),
							]),
						),
					)
				}

				const resolvedCount = Arr.countBy(resolveOutcomes, (ok) => ok)
				yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, resolvedCount)
				yield* Metric.update(AlertingMetrics.staleIncidentsResolvedTotal, resolvedCount)
			})

			const resolveOrphanedGroupIncidents = Effect.fn("AlertsService.resolveOrphanedGroupIncidents")(
				function* (
					orgId: OrgId,
					ruleId: AlertRuleId,
					normalized: NormalizedRule,
					evaluatedGroups: HashSet.HashSet<string>,
					timestamp: number,
					openIncidents: ReadonlyArray<AlertIncidentRow>,
					pushBudget: IncidentPushBudget,
				) {
					// Supplied from the tick-head prefetch instead of re-read here — this
					// was the single heaviest query shape in the service, because it read
					// the same set `processEvaluation` had already read moments earlier.
					//
					// Only incidents whose group was NOT evaluated survive the filter
					// below, and an unevaluated group is by definition one this tick wrote
					// nothing for, so the snapshot and a fresh read agree on every row that
					// matters here. What the snapshot cannot see is an incident resolved
					// out-of-band (a manual resolve via the API) since the tick began. The
					// resolve statement below is guarded on `status = 'open'` and gated on
					// its own row count so that case is a no-op rather than a duplicate
					// all-clear notification.
					const orphaned = Arr.filter(
						openIncidents,
						(i) => !HashSet.has(evaluatedGroups, i.groupKey ?? UNGROUPED_GROUP_KEY),
					)

					if (orphaned.length === 0) return

					// A group leaves the result set either because the thing it described
					// genuinely went away, or because the service stopped reporting — and
					// this path closes the incident AND fires a resolve notification, so
					// getting it wrong pages an all-clear in the middle of an ingest
					// outage.
					//
					// One probe per distinct (service scope, onset), one decision per
					// incident. A service-grouped rule probes each quiet service on its
					// own, and each incident's onset anchors its own fallback baseline: a
					// group that opened at noon must not be compared against the traffic
					// it had at 10:00, before it existed. Each orphan also carries its own
					// hold clock, so two groups that went quiet an hour apart reach their
					// ceilings an hour apart.
					const probes = new Map<string, LivenessVerdict>()
					const livenessFor = (services: ReadonlyArray<string>, openedAtMs: number) =>
						Effect.gen(function* () {
							const key = `${openedAtMs}\u0000${services.join("\u0000")}`
							const cached = probes.get(key)
							if (cached !== undefined) return cached
							const verdict = yield* telemetryStillFlowing(
								orgId,
								normalized,
								openedAtMs,
								timestamp,
								services,
							)
							probes.set(key, verdict)
							return verdict
						})

					const resolveOutcomes = yield* Effect.forEach(orphaned, (incident) => {
						const groupKey = incident.groupKey ?? UNGROUPED_GROUP_KEY
						return Effect.gen(function* () {
							// An uptime group leaves when its monitor is relinked or deleted, never
							// because telemetry stopped, so there is nothing to probe.
							const liveness: LivenessVerdict =
								normalized.signalType === "uptime"
									? {
											dataFlowing: true,
											reason: "ok",
											observedCount: 0,
											baselineCount: 0,
											ratio: null,
											samplingDelta: null,
										}
									: yield* livenessFor(
											livenessServicesForIncident(normalized, incident.groupKey),
											incident.firstTriggeredAt,
										)
							const gate = decideLivenessGate(
								incident,
								liveness,
								normalized.windowMinutes,
								timestamp,
							)
							if (gate.kind === "hold") {
								yield* recordHold(incident, gate, liveness, timestamp, null)
								return false
							}
							const syntheticEvaluation = makeSyntheticResolveEvaluation(
								normalized,
								gate.reason ?? "Auto-resolved: group no longer appears in evaluation results",
							)
							// `status = 'open'` in the predicate, plus RETURNING, is what makes
							// the prefetched snapshot safe: if this incident was resolved
							// out-of-band since the tick began, zero rows come back and we skip
							// the notification instead of paging a second all-clear. (The old
							// re-read had the same race between its own select and update; this
							// closes it rather than just narrowing it.)
							const resolved = yield* dbExecute((db) =>
								db.run(
									PG.update(AlertIncidents)
										.set({
											status: "resolved",
											resolvedAt: timestamp,
											holdReason: null,
											heldSince: null,
											updatedAt: timestamp,
										})
										.where(($) => [$.id.eq(incident.id), $.status.eq("open")])
										.returning("id"),
								),
							)
							if (resolved.length === 0) return false
							yield* syncStatusPages(
								normalized.signalType,
								{ orgId, alertIncidentId: incident.id },
								(db) =>
									resolveForAlertIncident(db, {
										orgId,
										alertIncidentId: incident.id,
										at: timestamp,
									}),
							)
							if (incident.holdReason !== null) {
								yield* Metric.update(AlertingMetrics.incidentsResolvedAfterHoldTotal, 1)
							}

							// Same rule as the lifecycle core's resolution plan: an incident
							// whose trigger was flap-suppressed carries an inherited
							// notification anchor and no delivered event. Announcing its
							// all-clear would also refresh that anchor, muting the trigger of
							// every later reopen while the resolves keep arriving.
							if (incident.lastDeliveredEventType == null && incident.lastNotifiedAt != null) {
								yield* Effect.logInfo(
									"Skipping resolve notification for flapping incident",
								).pipe(Effect.annotateLogs({ ruleId, incidentId: incident.id, groupKey }))
							} else {
								yield* queueIncidentNotifications(
									orgId,
									ruleForResolve(normalized, incident),
									{
										...incident,
										status: "resolved",
										resolvedAt: timestamp,
										holdReason: null,
										heldSince: null,
										updatedAt: timestamp,
									},
									syntheticEvaluation,
									"resolve",
									timestamp,
									pushBudget,
									afterHold(incident, gate.heldForMs),
								)
							}

							yield* dbExecute((db) =>
								db.run(
									PG.deleteFrom(AlertRuleStates).where(($) => [
										$.orgId.eq(orgId),
										$.ruleId.eq(ruleId),
										$.groupKey.eq(groupKey),
									]),
								),
							)
							return true
						})
					})

					// Counts what actually resolved, not what was a candidate: an incident
					// resolved out-of-band since the tick began is skipped above and must
					// not be counted here.
					const resolvedCount = Arr.countBy(resolveOutcomes, (ok) => ok)
					yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, resolvedCount)
					yield* Metric.update(AlertingMetrics.staleIncidentsResolvedTotal, resolvedCount)
				},
			)

			const SCHEDULER_LOCK_TTL_MS = 30_000

			// The tick deadline sits this far below SCHEDULER_LOCK_TTL_MS, leaving room
			// for processEvaluation's Postgres writes after the last warehouse call.
			const SCHEDULER_LOCK_MARGIN_MS = 5_000

			// Rules claimed per round trip. A chunk's locks are all dated from its
			// claim and its rules queue for the 5 lanes, so a larger chunk means older
			// locks by the time the last rule starts. The tick deadline bounds that
			// age below SCHEDULER_LOCK_TTL_MS; a larger chunk only defers more rules.
			const RULE_CLAIM_CHUNK_SIZE = 25

			// Time kept clear at the end of a tick for evaluations started late in its
			// spread: the last rule starts at least this long before the deadline.
			const SCHEDULER_SPREAD_TAIL_MS = 10_000

			const longQueryEvalMs = (row: StoredAlertRuleRow) =>
				alertQueryLimits(alertRuleIntervalMinutes(row)).timeSeconds * 1000 + 10_000

			// Raw SQL rules allowed more than the 1-minute query time limit run in their own
			// lane, so a 25s query holds neither the standard lane's slots nor its 30s claim.
			// Evaluations end by 60s, leaving the writes and tail inside the cron's 110s.
			const SCHEDULER_LANES = {
				standard: {
					concurrency: 5,
					lockTtlMs: SCHEDULER_LOCK_TTL_MS,
					claimChunkSize: RULE_CLAIM_CHUNK_SIZE,
					tickBudgetMs: () => runtime.schedulerTickBudgetMs(),
					evalTimeoutMs: (_row: StoredAlertRuleRow) => runtime.schedulerEvalTimeoutMs(),
					// Starts until the deadline; the deadline cuts a late evaluation short.
					startRoomMs: (_row: StoredAlertRuleRow) => 0,
				},
				long_query: {
					concurrency: 2,
					lockTtlMs: 100_000,
					claimChunkSize: 2,
					tickBudgetMs: () => 60_000,
					evalTimeoutMs: longQueryEvalMs,
					// Starts a rule only with room for its whole time limit, so a slow query is never cut short.
					startRoomMs: longQueryEvalMs,
				},
			} satisfies Record<AlertSchedulerLane, unknown>

			// Unchanged-state ticks skip the alert_rule_states upsert so the Electric
			// shape stays quiet; lastEvaluatedAt is refreshed at most this often. Under
			// 5 minutes, so claim jitter cannot skip a refresh on a 5-minute rule.
			const STATE_HEARTBEAT_MS = 4.5 * 60_000

			// `alert_rules.last_scheduled_at` is still exposed on the API and read by the
			// web diagnosis panel, but it is only refreshed this often — the per-minute
			// claim itself lives in the unpublished `alert_rule_claims` table so it never
			// enters Electric's replication stream. Mirrors STATE_HEARTBEAT_MS above.
			const SCHEDULER_HEARTBEAT_MS = STATE_HEARTBEAT_MS

			/**
			 * Rules are claimed a chunk at a time, not one statement per rule.
			 *
			 * This was the single largest cost in the service: 6,127 `INSERT
			 * alert_rule_claims` per hour at p50 1,187ms — 8,155s of wall time, MORE
			 * than every warehouse query in the alerting worker combined (5,388s), to
			 * acquire a lock guarding a query whose own p50 is 393ms. With the rule
			 * loop at concurrency 5 and `MAX_CONNECTIONS` also 5, every slot spent
			 * ~40% of each rule's critical path on the claim alone.
			 *
			 * Chunked rather than one batch for the whole tick, and that is the
			 * correctness constraint, not a tuning knob. `SCHEDULER_LOCK_TTL_MS` is
			 * 30s against a 60s tick interval, and the tick itself runs p50 51s / p95
			 * 85s — so it already overruns its interval and overlaps itself. Claiming
			 * every rule at tick head would date the whole tick's locks from T0: a
			 * rule evaluated at T0+50s would hold a lock that expired at T0+30s, and
			 * the next tick starting at T0+60s would re-claim and evaluate it
			 * CONCURRENTLY. Per-chunk claiming keeps a lock's age bounded by how long
			 * one chunk takes (~10s at this size) instead of by the whole tick, which
			 * preserves the guarantee the per-rule claim gave.
			 *
			 * Both statements still run inside ONE `execute` — under `DatabasePgLive`
			 * the handshake count is what costs, not the statement count.
			 *
			 * The claim: one multi-row `INSERT`, whose `INSERT` arm covers a rule's
			 * first tick. `setWhere` gates each row INDEPENDENTLY, so a loser's
			 * conflict update stays a no-op and `RETURNING` comes back as exactly the
			 * winners — the same row-level CAS as before, one round trip instead of N.
			 *
			 * The heartbeat: `alert_rules.last_scheduled_at` is gated in SQL so it
			 * touches zero rows — and writes no WAL tuple — on the ~4 of every 5 ticks
			 * that fall inside the heartbeat window. It runs only for the claim
			 * winners, and its failure is swallowed so it cannot cost a rule its
			 * evaluation: the claims are already committed by then, and the heartbeat
			 * is cosmetic.
			 */
			const claimRuleChunk = (
				chunk: ReadonlyArray<StoredAlertRuleRow>,
				timestamp: number,
				lockTtlMs: number,
			) =>
				dbExecute((db) =>
					Effect.gen(function* () {
						const claimed = yield* db.run(
							PG.insertInto(AlertRuleClaims)
								.values(
									chunk.map((row) => ({
										ruleId: row.id,
										orgId: row.orgId,
										lastScheduledAt: timestamp,
									})),
								)
								.onConflictDoUpdate({
									target: ["ruleId"],
									set: { lastScheduledAt: timestamp },
									where: ($) => $.lastScheduledAt.lt(timestamp - lockTtlMs),
								})
								.returning(($) => ({ id: $.ruleId })),
						)

						const [first, ...rest] = claimed
						if (first === undefined) return claimed

						// Matches the `Effect.ignore` this call carried when it was a
						// separate execute.
						yield* db
							.run(
								PG.update(AlertRules)
									.set({ lastScheduledAt: timestamp })
									.where(($) => [
										$.id.in_(first.id, ...rest.map((row) => row.id)),
										PG.or(
											$.lastScheduledAt.isNull(),
											$.lastScheduledAt.lt(timestamp - SCHEDULER_HEARTBEAT_MS),
										),
									]),
							)
							.pipe(
								Effect.ignore({
									log: "Warn",
									message: "Failed to stamp lastScheduledAt on claimed alert rules",
								}),
							)

						return claimed
					}),
				)

			// Each rule's last claim time, and the query limit failures it has run up.
			const loadClaims = (rows: ReadonlyArray<StoredAlertRuleRow>) =>
				(Arr.isReadonlyArrayEmpty(rows)
					? Effect.succeed([])
					: dbExecute((db) =>
							db.run(
								PG.from(AlertRuleClaims)
									.select("ruleId", "lastScheduledAt", "consecutiveLimitFailures")
									.where(($) => [$.ruleId.in_(...Arr.map(rows, (row) => row.id))]),
							),
						)
				).pipe(
					Effect.map((claims) => ({
						lastClaimedAt: new Map(
							claims.map((claim) => [claim.ruleId, claim.lastScheduledAt] as const),
						),
						limitFailures: new Map(
							claims.map((claim) => [claim.ruleId, claim.consecutiveLimitFailures] as const),
						),
					})),
				)

			// Expires each claim at the given timestamp (the predicate leaves a newer
			// claim alone), so the next tick finds the rule due and orders it first.
			// Best-effort: an unreleased claim still expires after SCHEDULER_LOCK_TTL_MS.
			const releaseClaims = (claims: ReadonlyArray<{ id: AlertRuleId; timestamp: number }>) =>
				Effect.forEach(
					Record.values(Arr.groupBy(claims, (claim) => String(claim.timestamp))),
					(group) => {
						const [first, ...rest] = group
						return dbExecute((db) =>
							db.run(
								PG.update(AlertRuleClaims)
									.set({ lastScheduledAt: 0 })
									.where(($) => [
										$.ruleId.in_(first.id, ...rest.map((claim) => claim.id)),
										$.lastScheduledAt.eq(first.timestamp),
									]),
							),
						)
					},
					{ discard: true },
				).pipe(Effect.ignore({ log: "Warn", message: "Failed to release alert rule claims" }))

			/**
			 * The two per-rule reads the scheduler used to issue inside its loop,
			 * fetched once for the whole tick.
			 *
			 * Between them these were ~13k queries/hour in production — one
			 * `alert_rule_states` select and one `alert_incidents` select per rule per
			 * group per minute, each paying a full dial under `DatabasePgLive`.
			 *
			 * Hoisting them is not a staleness trade, because of how the writes are
			 * scoped. Every key here is `(orgId, ruleId, groupKey)`, `processEvaluation`
			 * runs at most once per key per tick, and its writes only ever touch its own
			 * key: the state upsert targets that key's primary key, and both incident
			 * updates target `openIncident.id` — the incident belonging to that same
			 * key. So no group can read a value another group has invalidated.
			 *
			 * `openIncidentsForRule` is the exception and is documented at its use site
			 * in `resolveOrphanedGroupIncidents`.
			 */
			interface TickPrefetch {
				readonly stateFor: (
					orgId: OrgId,
					ruleId: AlertRuleId,
					groupKey: string,
				) => AlertRuleStateRow | null
				readonly openIncidentFor: (
					orgId: OrgId,
					ruleId: AlertRuleId,
					groupKey: string,
				) => AlertIncidentRow | null
				readonly openIncidentsForRule: (
					orgId: OrgId,
					ruleId: AlertRuleId,
				) => ReadonlyArray<AlertIncidentRow>
			}

			const EMPTY_INCIDENTS: ReadonlyArray<AlertIncidentRow> = []

			const groupCacheKey = (orgId: string, ruleId: string, groupKey: string) =>
				`${orgId}\u0000${ruleId}\u0000${groupKey}`
			const ruleCacheKey = (orgId: string, ruleId: string) => `${orgId}\u0000${ruleId}`

			/**
			 * Load the tick's state and open-incident rows in ONE `execute`.
			 *
			 * Two statements, one dial — the handshake is the cost, not the statement
			 * (`ErrorsService.loadOrgTickPreamble`). `orgId` is in both predicates for
			 * the index rather than for correctness: rule ids are globally unique, so
			 * the id list already scopes the read, but without `orgId` neither predicate
			 * can use its leading index column.
			 */
			const loadTickPrefetch = Effect.fnUntraced(function* (rows: ReadonlyArray<StoredAlertRuleRow>) {
				if (Arr.isReadonlyArrayEmpty(rows)) {
					return {
						stateFor: () => null,
						openIncidentFor: () => null,
						openIncidentsForRule: () => EMPTY_INCIDENTS,
					} satisfies TickPrefetch
				}

				const ruleIds = Arr.map(rows, (row) => row.id)
				const orgIds = Arr.dedupe(Arr.map(rows, (row) => row.orgId))

				const { stateRows, incidentRows } = yield* dbExecute((db) =>
					Effect.all(
						{
							stateRows: db.run(
								PG.from(AlertRuleStates)
									.select()
									.where(($) => [$.orgId.in_(...orgIds), $.ruleId.in_(...ruleIds)]),
							),
							incidentRows: db.run(
								PG.from(AlertIncidents)
									.select()
									.where(($) => [
										$.orgId.in_(...orgIds),
										$.ruleId.in_(...ruleIds),
										$.status.eq("open"),
									]),
							),
						},
						{ concurrency: "unbounded" },
					),
				)

				const stateByGroup = MutableHashMap.fromIterable(
					Arr.map(
						stateRows,
						(state) => [groupCacheKey(state.orgId, state.ruleId, state.groupKey), state] as const,
					),
				)

				// `groupKey` is nullable on this table. The per-group lookup replaces an
				// `eq(groupKey, …)` predicate, and SQL equality never matches NULL, so a
				// null-keyed incident must not be reachable from it — hence the filterMap.
				// The per-rule grouping below keeps them: its consumer coalesces null to
				// the ungrouped key.
				const incidentByGroup = MutableHashMap.fromIterable(
					Arr.filterMap(incidentRows, (incident) =>
						incident.groupKey === null
							? Result.failVoid
							: Result.succeed([
									groupCacheKey(incident.orgId, incident.ruleId, incident.groupKey),
									incident,
								] as const),
					),
				)

				const incidentsByRule = Arr.groupBy(incidentRows, (incident) =>
					ruleCacheKey(incident.orgId, incident.ruleId),
				)

				return {
					stateFor: (orgId, ruleId, groupKey) =>
						Option.getOrNull(
							MutableHashMap.get(stateByGroup, groupCacheKey(orgId, ruleId, groupKey)),
						),
					openIncidentFor: (orgId, ruleId, groupKey) =>
						Option.getOrNull(
							MutableHashMap.get(incidentByGroup, groupCacheKey(orgId, ruleId, groupKey)),
						),
					openIncidentsForRule: (orgId, ruleId) =>
						Record.get(incidentsByRule, ruleCacheKey(orgId, ruleId)).pipe(
							Option.getOrElse(() => EMPTY_INCIDENTS),
						),
				} satisfies TickPrefetch
			})

			/**
			 * Apply the tick's accumulated `alert_rule_states` housekeeping set-based.
			 *
			 * Replaces two per-rule statements that were each gated to touch zero rows
			 * in steady state — cheap in WAL terms, but still a full dial apiece under
			 * `DatabasePgLive`, every rule, every minute. At most three statements per
			 * tick now, and none at all when nothing evaluated.
			 *
			 * `orgId` is in each predicate for the index, not for correctness: rule ids
			 * are globally unique (`alert_rules.id` is the primary key), so the id lists
			 * already scope these to the right tenant. Without it the predicate could
			 * not use the `(org_id, rule_id, group_key)` primary key at all.
			 *
			 * Best-effort by design. Housekeeping must not fail a tick whose real work —
			 * evaluation, incidents, notifications — has already completed. This does
			 * cost per-rule attribution: a failure here is logged for the tick rather
			 * than recorded against the individual rule as it was when inline.
			 */
			const flushRuleStateHousekeeping = Effect.fnUntraced(function* (
				selfHeal: ReadonlyArray<{
					readonly orgId: OrgId
					readonly ruleId: AlertRuleId
					readonly grouped: boolean
				}>,
				clearError: ReadonlyArray<{
					readonly orgId: OrgId
					readonly ruleId: AlertRuleId
				}>,
				timestamp: number,
				limitFailures: ReadonlyMap<string, number>,
			) {
				const bestEffort =
					(label: string) => (effect: Effect.Effect<unknown, AlertPersistenceError>) =>
						effect.pipe(
							Effect.tapError((error) =>
								Effect.logWarning(label).pipe(
									Effect.annotateLogs({ message: error.message }),
								),
							),
							Effect.ignore,
						)

				const selfHealOrgIds = Arr.dedupe(Arr.map(selfHeal, (t) => t.orgId))
				// One pass: since Effect 4.0.0 `partition` returns [passes, fails], so the
				// `Result` success arm carries the grouped ids and the failure arm the ungrouped.
				const [groupedRuleIds, ungroupedRuleIds] = Arr.partition(selfHeal, (t) =>
					t.grouped ? Result.succeed(t.ruleId) : Result.fail(t.ruleId),
				)

				// A grouped rule can never legitimately own an ungrouped state row, and
				// an ungrouped rule can never own a grouped one. Two statements because
				// the two shapes need opposite `group_key` predicates.
				if (groupedRuleIds.length > 0) {
					yield* dbExecute((db) =>
						db.run(
							PG.deleteFrom(AlertRuleStates).where(($) => [
								$.orgId.in_(...selfHealOrgIds),
								$.ruleId.in_(...groupedRuleIds),
								$.groupKey.eq(UNGROUPED_GROUP_KEY),
							]),
						),
					).pipe(bestEffort("Failed to self-heal ungrouped state rows for grouped rules"))
				}

				if (ungroupedRuleIds.length > 0) {
					yield* dbExecute((db) =>
						db.run(
							PG.deleteFrom(AlertRuleStates).where(($) => [
								$.orgId.in_(...selfHealOrgIds),
								$.ruleId.in_(...ungroupedRuleIds),
								$.groupKey.neq(UNGROUPED_GROUP_KEY),
							]),
						),
					).pipe(bestEffort("Failed to self-heal grouped state rows for ungrouped rules"))
				}

				// Only rules that evaluated cleanly are listed, so a rule that failed
				// this tick keeps the `lastError` `recordEvaluationFailure` wrote for it.
				if (clearError.length > 0) {
					yield* dbExecute((db) =>
						db.run(
							PG.update(AlertRuleStates)
								.set({ lastError: null, lastErrorKind: null, updatedAt: timestamp })
								.where(($) => [
									$.orgId.in_(...Arr.dedupe(Arr.map(clearError, (t) => t.orgId))),
									$.ruleId.in_(...Arr.map(clearError, (t) => t.ruleId)),
									$.lastError.isNotNull(),
								]),
						),
					).pipe(bestEffort("Failed to clear stored evaluation errors"))
					// A clean check ends a run of query limit failures; only rules that had one are written.
					const [firstReset, ...restReset] = Arr.filter(
						clearError,
						(target) => (limitFailures.get(target.ruleId) ?? 0) > 0,
					)
					if (firstReset !== undefined) {
						yield* dbExecute((db) =>
							db.run(
								PG.update(AlertRuleClaims)
									.set({ consecutiveLimitFailures: 0 })
									.where(($) => [
										$.ruleId.in_(
											firstReset.ruleId,
											...Arr.map(restReset, (t) => t.ruleId),
										),
										$.consecutiveLimitFailures.gt(0),
									]),
							),
						).pipe(bestEffort("Failed to reset alert rule query limit failures"))
					}
				}
			})

			const recordEvaluationStatus = (evaluation: EvaluatedRule) =>
				Match.value(evaluation.status).pipe(
					Match.when("breached", () => Metric.update(AlertingMetrics.rulesBreachedTotal, 1)),
					Match.when("healthy", () => Metric.update(AlertingMetrics.rulesHealthyTotal, 1)),
					Match.when("skipped", () => Metric.update(AlertingMetrics.rulesSkippedTotal, 1)),
					Match.exhaustive,
				)

			// One POST per org. Awaited by the tick so the Worker stays alive for the writes; a failed
			// or timed-out POST, or one cut by the budget, drops its rows (Postgres holds the alert state).
			const ingestAlertChecks = Effect.fn("AlertsService.ingestAlertChecks")(function* (
				checks: ReadonlyArray<AlertChecksRow>,
			) {
				const written = yield* Ref.make(0)
				yield* Effect.forEach(
					Object.entries(Arr.groupBy(checks, (check) => check.OrgId)),
					([orgId, rows]) =>
						// Not metered to Autumn: internal bookkeeping rows, not customer telemetry.
						warehouse.ingest(systemTenant(decodeOrgIdSync(orgId)), "alert_checks", rows).pipe(
							Effect.timeout(ALERT_CHECK_INGEST_TIMEOUT),
							Effect.andThen(Ref.update(written, (n) => n + rows.length)),
							Effect.catchCause((cause) =>
								Effect.logWarning("Dropped alert_checks audit rows").pipe(
									Effect.annotateLogs({
										orgId,
										rowCount: rows.length,
										cause: summarizeCause(cause),
									}),
								),
							),
						),
					{ concurrency: ALERT_CHECK_INGEST_CONCURRENCY, discard: true },
				).pipe(
					Effect.timeout(ALERT_CHECK_INGEST_BUDGET),
					Effect.catchCause(() => Effect.logWarning("alert_checks ingest hit its budget")),
				)
				const droppedCount = checks.length - (yield* Ref.get(written))
				if (droppedCount > 0) {
					yield* Metric.update(AlertingMetrics.alertChecksDroppedTotal, droppedCount)
				}
				yield* Effect.annotateCurrentSpan({
					"maple.alerting.alert_checks_rows": checks.length,
					"maple.alerting.alert_checks_dropped": droppedCount,
				})
				return droppedCount
			})

			const evaluateScheduledRules = Effect.fn("AlertsService.evaluateScheduledRules")(function* (
				laneName: AlertSchedulerLane,
				// Receives the forked alert_checks ingest; the caller joins it.
				checkIngest: Ref.Ref<Option.Option<Fiber.Fiber<number>>>,
			) {
				const lane = SCHEDULER_LANES[laneName]
				const tickStart = yield* now
				// One window for the whole tick: a rule that starts after the spread crossed a
				// minute must not skip ahead of the rules that started before it.
				const tickWindowEndMs = snapAlertWindowEndMs(tickStart)
				const enabledRows = yield* dbExecute((db) =>
					db.run(
						selectStoredAlertRules()
							.where(($) => [$.enabled.eq(true)])
							.orderBy(["updatedAt", "asc"]),
					),
				)
				if (laneName === "standard") {
					yield* Metric.update(AlertingMetrics.activeRulesGauge, enabledRows.length)
				}
				const rows = Arr.filter(enabledRows, (row) => alertSchedulerLaneOf(row) === laneName)

				// A rule is checked on its interval (a fifth of its window unless picked), not every tick.
				const { lastClaimedAt, limitFailures } = yield* loadClaims(rows)
				const dueRows = Arr.filter(rows, (row) =>
					isAlertRuleDue({
						ruleId: row.id,
						intervalMinutes: alertRuleIntervalMinutes(row),
						updatedAt: row.updatedAt,
						lastClaimedAt: lastClaimedAt.get(row.id),
						windowEndMs: tickWindowEndMs,
					}),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.alerting.lane": laneName,
					"maple.alerting.rules_enabled": rows.length,
					"maple.alerting.rules_due": dueRows.length,
				})

				const prefetch = yield* loadTickPrefetch(dueRows)

				// Warm the org warehouse-config memo for the whole tick in one read,
				// before the per-rule forEach below fans out at concurrency 5.
				//
				// Without this, the fan-out is the worst possible shape for that memo:
				// `interleaveAlertRulesByOrg` deliberately puts consecutive rules on
				// DIFFERENT orgs (for fairness), so the five in-flight fibers miss on
				// five different orgs at once and none of them has written the memo yet
				// when the others look. Measured at 13,989 Postgres resolutions/day at
				// p50 632ms — ~2.4 hours of blocked wall time — against a 94% memo hit
				// rate, i.e. the misses are concurrency, not cache sizing.
				//
				// Best-effort: priming is an optimization, and a failure here must not
				// take down a tick that would otherwise resolve each config on demand.
				yield* orgChSettings
					.primeRuntimeConfigs(Arr.dedupe(Arr.map(dueRows, (row) => row.orgId)))
					.pipe(Effect.ignore({ log: "Warn", message: "Failed to prime alert runtime configs" }))

				// Incremented from fibers running under the concurrent per-rule forEach
				// below, so it must be a Ref rather than a mutable closure variable.
				const evaluationFailureCount = yield* Ref.make(0)
				const warehouseUnavailableSkips = yield* Ref.make(
					HashMap.empty<
						OrgId,
						{
							readonly rules: number
							readonly upstreamStatus: number | undefined
							readonly message: string
						}
					>(),
				)
				// Chunk makes concurrent appends immutable without copying the full buffer.
				const pendingChecks = yield* Ref.make(Chunk.empty<AlertChecksRow>())
				const issueBudget = yield* Ref.make(ISSUE_UPSERTS_PER_TICK)
				const pendingTriages = yield* Ref.make(Chunk.empty<MaybeEnqueueTriageInput>())
				const pushBudget = yield* makeIncidentPushBudget

				// Two housekeeping statements used to run per rule, inside the loop.
				// Both are gated to touch zero rows in steady state (to keep the
				// Electric shape quiet), but a zero-row statement still costs a full
				// dial under `DatabasePgLive` — ~2 dials × every rule × every minute.
				// The rules they need are accumulated here and applied set-based once
				// per tick instead. Refs for the same reason as `evaluationFailureCount`:
				// the forEach below runs at concurrency 5.
				//
				// Deliberately separate lists, because the two statements do not cover
				// the same rules: the self-heal delete is skipped on the multi-service
				// path (which returns early), while the error clear applies to every
				// rule that evaluated cleanly.
				const selfHealTargets = yield* Ref.make(
					Chunk.empty<{
						readonly orgId: OrgId
						readonly ruleId: AlertRuleId
						readonly grouped: boolean
					}>(),
				)
				const clearErrorTargets = yield* Ref.make(
					Chunk.empty<{
						readonly orgId: OrgId
						readonly ruleId: AlertRuleId
					}>(),
				)

				const recordEvaluationFailure = Effect.fnUntraced(function* (
					row: StoredAlertRuleRow,
					error: { readonly message: string },
					failureCategory: string,
					failure: {
						readonly kind: AlertEvaluationErrorKind
						readonly durationMs: number
						/** The claim the failed check ran under. */
						readonly claimedAt: number
					},
					fields?: {
						readonly upstreamStatus?: number
						readonly quotaSetting?: string
						readonly pipe?: string
					},
				) {
					yield* Ref.update(evaluationFailureCount, (count) => count + 1)
					yield* Metric.update(AlertingMetrics.evaluationFailuresTotal, 1)
					yield* Effect.logError("Alert rule evaluation failed").pipe(
						Effect.annotateLogs({
							workerId,
							ruleId: row.id,
							orgId: row.orgId,
							failureCategory,
							errorKind: failure.kind,
							errorMessage: error.message,
							upstreamStatus: fields?.upstreamStatus,
							quotaSetting: fields?.quotaSetting,
							pipe: fields?.pipe,
						}),
					)
					yield* persistEvaluationError(row, error.message, failureCategory, true, failure)
					if (isQueryLimitFailure(failure.kind))
						yield* recordQueryLimitFailure(row, failure.claimedAt, failure.kind)
				})

				// The rule's query hit its time or memory limit. Three times in a row slows the rule to
				// the next interval with a larger limit, written without `updatedAt` so it is not an edit.
				const recordQueryLimitFailure = (
					row: StoredAlertRuleRow,
					claimedAt: number,
					kind: AlertEvaluationErrorKind,
				) =>
					Effect.gen(function* () {
						const counted = yield* dbExecute((db) =>
							db.run(
								PG.update(AlertRuleClaims)
									.set(($) => ({
										consecutiveLimitFailures: $.consecutiveLimitFailures.add(1),
									}))
									// Under this check's claim: an edit since replaced it and starts a fresh count.
									.where(($) => [$.ruleId.eq(row.id), $.lastScheduledAt.eq(claimedAt)])
									.returning(($) => ({ failures: $.consecutiveLimitFailures })),
							),
						)
						if ((counted[0]?.failures ?? 0) < SLOWDOWN_AFTER_LIMIT_FAILURES) return
						const fromMinutes = alertRuleIntervalMinutes(row)
						const toMinutes = nextSlowerAlertInterval(
							fromMinutes,
							row.windowMinutes,
							kind === "query_too_much_memory" ? "memory" : "time",
						)
						if (toMinutes === null) return
						const slowedAt = yield* now
						yield* dbExecute((db) =>
							db.transaction(
								Effect.andThen(
									db.run(
										PG.update(AlertRules)
											.set({ slowedIntervalMinutes: toMinutes, slowedAt })
											// Fenced on the version that failed: an edit since has its own fresh start.
											.where(($) => [
												$.orgId.eq(row.orgId),
												$.id.eq(row.id),
												$.updatedAt.eq(row.updatedAt),
											]),
									),
									db.run(
										PG.update(AlertRuleClaims)
											.set({ consecutiveLimitFailures: 0 })
											.where(($) => [$.ruleId.eq(row.id)]),
									),
								),
							),
						)
						yield* Metric.update(AlertingMetrics.rulesSlowedTotal, 1)
						yield* Effect.logWarning(
							"Alert rule slowed down after repeated query limit failures",
						).pipe(
							Effect.annotateLogs({
								workerId,
								ruleId: row.id,
								orgId: row.orgId,
								fromIntervalMinutes: fromMinutes,
								toIntervalMinutes: toMinutes,
							}),
						)
					}).pipe(
						// Best-effort like the error it follows: the rule still retries on its interval.
						Effect.ignore({
							log: "Warn",
							message: "Failed to record an alert rule query limit failure",
						}),
					)

				// The warehouse itself is down (a 5xx or unreachable backend): the rule is
				// fine, so this is a skip, not a failure. Logged once per org per tick.
				const recordWarehouseUnavailableSkip = Effect.fnUntraced(function* (
					row: StoredAlertRuleRow,
					error: { readonly message: string },
					failureCategory: string,
					upstreamStatus: number | undefined,
					durationMs: number,
				) {
					yield* Ref.update(warehouseUnavailableSkips, (skips) =>
						HashMap.set(skips, row.orgId, {
							rules: Option.match(HashMap.get(skips, row.orgId), {
								onNone: () => 1,
								onSome: (entry) => entry.rules + 1,
							}),
							upstreamStatus,
							message: error.message,
						}),
					)
					yield* Metric.update(AlertingMetrics.rulesSkippedTotal, 1)
					yield* persistEvaluationError(row, error.message, failureCategory, false, {
						kind: null,
						durationMs,
					})
				})

				const persistEvaluationError = Effect.fnUntraced(function* (
					row: StoredAlertRuleRow,
					rawMessage: string,
					failureCategory: string,
					ruleAtFault: boolean,
					failure: { readonly kind: AlertEvaluationErrorKind | null; readonly durationMs: number },
				) {
					const failedAt = yield* now
					const message = rawMessage.slice(0, 500)

					// Audit row: a failed evaluation is a check that produced no
					// observation — record it so the check history has no silent gaps.
					yield* Ref.update(
						pendingChecks,
						Chunk.append({
							OrgId: row.orgId,
							RuleId: row.id,
							GroupKey: UNGROUPED_GROUP_KEY,
							Timestamp: toIngestDateTime64(failedAt),
							Status: "error",
							SkipReason: "",
							SignalType: row.signalType,
							Comparator: row.comparator,
							Threshold: row.threshold,
							ObservedValue: null,
							SampleCount: 0,
							WindowMinutes: row.windowMinutes,
							WindowStart: toIngestDateTime64(tickWindowEndMs - row.windowMinutes * 60_000),
							WindowEnd: toIngestDateTime64(tickWindowEndMs),
							ConsecutiveBreaches: 0,
							ConsecutiveHealthy: 0,
							IncidentId: null,
							IncidentTransition: "none",
							EvaluationDurationMs: failure.durationMs,
							ErrorMessage: message,
							ErrorCategory: failureCategory,
							Level: "",
						}),
					)

					// An outage keeps the check row but not lastError, so the rule is not shown
					// as broken for a fault that is not its own.
					if (!ruleAtFault) return

					// Persist the failure to alert_rule_states so listRules/Electric can
					// surface it. Churn-gated (the states shape is Electric-synced): skip
					// when the same message was written within the heartbeat window, and
					// never clobber the state-machine counters in the conflict set.
					// Best-effort: recording a failure must not itself fail the tick.
					yield* Effect.gen(function* () {
						const state =
							(yield* dbExecute((db) =>
								db.run(
									PG.from(AlertRuleStates)
										.select("lastError", "lastEvaluatedAt")
										.where(($) => [
											$.orgId.eq(row.orgId),
											$.ruleId.eq(row.id),
											$.groupKey.eq(UNGROUPED_GROUP_KEY),
										])
										.limit(1),
								),
							))[0] ?? null
						const unchanged =
							state != null &&
							state.lastError === message &&
							state.lastEvaluatedAt != null &&
							failedAt - state.lastEvaluatedAt < STATE_HEARTBEAT_MS
						if (unchanged) return
						yield* dbExecute((db) =>
							db.run(
								PG.insertInto(AlertRuleStates)
									.values({
										orgId: row.orgId,
										ruleId: row.id,
										groupKey: UNGROUPED_GROUP_KEY,
										consecutiveBreaches: 0,
										consecutiveHealthy: 0,
										lastStatus: null,
										lastValue: null,
										lastSampleCount: null,
										lastEvaluatedAt: failedAt,
										lastError: message,
										lastErrorKind: failure.kind,
										updatedAt: failedAt,
									})
									.onConflictDoUpdate({
										target: ["orgId", "ruleId", "groupKey"],
										set: {
											lastError: message,
											lastErrorKind: failure.kind,
											lastEvaluatedAt: failedAt,
											updatedAt: failedAt,
										},
									}),
							),
						)
					}).pipe(
						Effect.tapError((persistError) =>
							Effect.logWarning("Failed to persist alert evaluation error").pipe(
								Effect.annotateLogs({
									ruleId: row.id,
									message: persistError.message,
								}),
							),
						),
						Effect.ignore,
					)
				})

				// No claim and no evaluation starts after `deadline`, and an evaluation
				// cannot run past it, so a rule's warehouse work ends before its claim
				// (dated at or after tickStart) expires and the next tick re-claims it.
				// Rules not started are left unclaimed or expire, and run next tick.
				const deadline =
					tickStart + Math.min(lane.tickBudgetMs(), lane.lockTtlMs - SCHEDULER_LOCK_MARGIN_MS)
				const deferredRules = yield* Ref.make(0)
				const deferRules = (count: number) => Ref.update(deferredRules, (n) => n + count)
				// Claims released after the pool drains, so these rules are due next tick: won but
				// never started, failed, or (with their earlier claim) never claimed this tick.
				const retryClaims = yield* Ref.make(Chunk.empty<{ id: AlertRuleId; timestamp: number }>())
				const retryUnclaimed = (chunk: ReadonlyArray<StoredAlertRuleRow>) =>
					Ref.update(
						retryClaims,
						Chunk.appendAll(
							Chunk.fromIterable(
								Arr.filterMap(chunk, (row) => {
									// A live claim belongs to another tick still evaluating the rule.
									const claimedAt = lastClaimedAt.get(row.id) ?? 0
									return claimedAt > 0 && claimedAt < tickStart - lane.lockTtlMs
										? Result.succeed({ id: row.id, timestamp: claimedAt })
										: Result.failVoid
								}),
							),
						),
					)
				const evaluatedRules = yield* Ref.make(0)
				// Orgs whose warehouse was down (5xx or unreachable) on a rule this tick.
				// Their other rules are skipped rather than evaluated: each would fail the
				// same way while holding one of the five evaluation lanes. A timeout does
				// not trip it: that may be one rule's query or the tick's own deadline.
				const unavailableOrgs = yield* Ref.make(HashSet.empty<OrgId>())
				const markOrgUnavailable = (orgId: OrgId) => Ref.update(unavailableOrgs, HashSet.add(orgId))

				const evaluateBeforeDeadline = (row: StoredAlertRuleRow, rule: NormalizedRule) =>
					Effect.flatMap(now, (startedAt) =>
						evaluateRule(row.orgId, rule, tickWindowEndMs).pipe(
							Effect.timeoutOrElse({
								duration: Duration.millis(
									Math.max(0, Math.min(lane.evalTimeoutMs(row), deadline - startedAt)),
								),
								orElse: () =>
									Effect.fail(
										new QueryEngineTimeoutError({
											message: "Alert evaluation exceeded the scheduler tick deadline",
										}),
									),
							}),
						),
					)

				// A rule whose claim this tick won. `timestamp` is its chunk's claim time,
				// which processEvaluation stamps on state and incident rows.
				const evaluateClaimedRule = (row: StoredAlertRuleRow, timestamp: number, startedAt: number) =>
					Effect.gen(function* () {
						// Uptime rules never read the warehouse, so its outage does not skip them.
						if (
							row.signalType !== "uptime" &&
							HashSet.has(yield* Ref.get(unavailableOrgs), row.orgId)
						) {
							return yield* new WarehouseUpstreamError({
								message: "Skipped: this org's warehouse failed earlier in the tick",
								pipeName: "alertEvaluation",
							})
						}
						const ruleStart = yield* now
						const normalized = yield* normalizeRuleRow(row)
						const stateWrites: RuleStateWrites = yield* Ref.make(emptyRuleStateBuffer)
						const flushingStates = withRuleStateFlush(
							{ ruleId: row.id, claimedAt: timestamp, ruleUpdatedAt: row.updatedAt },
							stateWrites,
							pendingChecks,
						)

						if (normalized.serviceNames.length > 1) {
							yield* Effect.forEach(yield* perServiceRules(normalized), ({ groupKey, rule }) =>
								Effect.gen(function* () {
									const observations = yield* evaluateBeforeDeadline(row, rule)
									// A service with no rows at all used to be dropped here,
									// which left its open incident frozen for as long as it
									// stayed quiet. An empty window is an observation too,
									// the same one the ungrouped path derives, and its open
									// incident goes through the liveness gate like any other.
									const evaluation =
										observations[0]?.evaluation ??
										applyEvaluationLogic(rule, {
											value: null,
											sampleCount: 0,
											hasData: false,
										})
									yield* recordEvaluationStatus(evaluation)
									yield* processEvaluation(
										row,
										normalized,
										evaluation,
										groupKey,
										timestamp,
										pendingChecks,
										issueBudget,
										pendingTriages,
										pushBudget,
										prefetch,
										stateWrites,
										tickWindowEndMs,
									)
								}),
							).pipe(flushingStates)

							yield* resolveOrphanedGroupIncidents(
								row.orgId,
								normalized.id,
								normalized,
								HashSet.fromIterable(normalized.serviceNames),
								timestamp,
								prefetch.openIncidentsForRule(row.orgId, row.id),
								pushBudget,
							)
							yield* Metric.update(
								AlertingMetrics.ruleEvaluationDurationMs,
								(yield* now) - ruleStart,
							)
							return
						}

						// Uniform grouped/ungrouped path. `evaluateRule` returns one
						// outcome per group already keyed in storage vocabulary: a single
						// UNGROUPED_GROUP_KEY entry (with a no-data fallback) when the
						// compiled plan is ungrouped. So both shapes flow through the
						// same loop with no key translation here.
						const results = yield* evaluateBeforeDeadline(row, normalized)
						// An uptime rule has no plan; it is keyed by its monitor's service when linked.
						const grouped =
							normalized.signalType === "uptime"
								? results.some((r) => r.groupKey !== UNGROUPED_GROUP_KEY)
								: isGroupedPlan(normalized.compiledPlan)
						const excludeSet = HashSet.fromIterable(normalized.excludeServiceNames)
						const eligible = grouped
							? Arr.filter(results, (r) => !HashSet.has(excludeSet, r.groupKey))
							: results

						yield* Effect.forEach(eligible, ({ evaluation, groupKey }) =>
							Effect.gen(function* () {
								yield* recordEvaluationStatus(evaluation)
								yield* processEvaluation(
									row,
									normalized,
									evaluation,
									groupKey,
									timestamp,
									pendingChecks,
									issueBudget,
									pendingTriages,
									pushBudget,
									prefetch,
									stateWrites,
									tickWindowEndMs,
								)
							}),
						).pipe(flushingStates)

						const evaluatedGroups = HashSet.fromIterable(Arr.map(eligible, (r) => r.groupKey))
						yield* resolveOrphanedGroupIncidents(
							row.orgId,
							normalized.id,
							normalized,
							evaluatedGroups,
							timestamp,
							prefetch.openIncidentsForRule(row.orgId, row.id),
							pushBudget,
						)

						// Self-heal state rows whose key shape contradicts the rule's
						// groupedness: a grouped rule can never legitimately own an
						// ungrouped row (left behind when this rule evaluated ungrouped,
						// or by recordEvaluationFailure), and vice versa. Orphan resolution
						// above only deletes incident-backed rows. Zero rows touched in
						// steady state, so the Electric shape stays quiet.
						//
						// Applied set-based after the loop (see `flushSelfHeal`). Safe to
						// defer: it is scoped to this rule and this rule's own writes are
						// already done, so end-of-tick is the same state it would have seen
						// here.
						yield* Ref.update(
							selfHealTargets,
							Chunk.append({ orgId: row.orgId, ruleId: row.id, grouped }),
						)

						yield* Metric.update(
							AlertingMetrics.ruleEvaluationDurationMs,
							(yield* now) - ruleStart,
						)
					}).pipe(
						// The rule evaluated cleanly: clear any stored evaluation error.
						// Conditional on lastError IS NOT NULL so healthy steady-state
						// ticks touch zero rows (no Electric shape churn). This also
						// covers grouped/multi-service rules, whose "__total__" error row
						// is never revisited by upsertState.
						//
						// Accumulated and applied set-based after the loop. Only rules that
						// reach here are cleared, so a rule that failed this tick keeps the
						// `lastError` that `recordEvaluationFailure` just wrote for it.
						Effect.tap(() =>
							Ref.update(clearErrorTargets, Chunk.append({ orgId: row.orgId, ruleId: row.id })),
						),
						// A rule that did not finish cleanly retries next tick, not a full interval later,
						// unless its query hit its limit: it would only hit it again.
						Effect.tapCause((cause) =>
							Option.exists(Cause.findErrorOption(cause), (error) =>
								isQueryLimitFailure(evaluationErrorKind(error)),
							)
								? Effect.void
								: Ref.update(retryClaims, Chunk.append({ id: row.id, timestamp })),
						),
						// Not an evaluation failure: the tick that re-claimed the rule owns
						// its state now, so record nothing and leave the rest to it.
						Effect.catchTag("@maple/alerts/AlertRuleClaimLostError", (lost) =>
							Effect.logWarning(
								"Alert rule claim lost mid-evaluation; stopping this rule",
							).pipe(
								Effect.annotateLogs({
									workerId,
									ruleId: lost.ruleId,
									claimedAt: lost.claimedAt,
									currentClaimAt: lost.currentClaimAt ?? undefined,
								}),
							),
						),
						Effect.catch((error) =>
							Option.match(warehouseOutageOf(error), {
								onSome: (outage) =>
									markOrgUnavailable(row.orgId).pipe(
										Effect.andThen(
											Effect.flatMap(now, (failedAt) =>
												recordWarehouseUnavailableSkip(
													row,
													outage,
													outage.error.code,
													outage.upstreamStatus,
													failedAt - startedAt,
												),
											),
										),
									),
								onNone: () =>
									Effect.flatMap(now, (failedAt) =>
										recordEvaluationFailure(
											row,
											error,
											error.error.code,
											{
												kind: evaluationErrorKind(error),
												durationMs: failedAt - startedAt,
												claimedAt: timestamp,
											},
											"pipeName" in error
												? {
														pipe: error.pipeName,
														...(error._tag ===
														"@maple/http/errors/WarehouseQuotaExceededError"
															? {
																	quotaSetting: error.setting,
																}
															: undefined),
														...(error._tag ===
															"@maple/http/errors/WarehouseUpstreamError" ||
														error._tag === "@maple/http/errors/WarehouseAuthError"
															? {
																	upstreamStatus: error.upstreamStatus,
																}
															: undefined),
													}
												: undefined,
										),
									),
							}),
						),
						// A crash in one rule must not end the tick for every rule after it.
						Effect.catchDefect((defect) =>
							Effect.logError("Alert rule evaluation crashed").pipe(
								Effect.annotateLogs({
									ruleId: row.id,
									orgId: row.orgId,
									cause: summarizeCause(Cause.die(defect)),
								}),
								Effect.andThen(
									Effect.flatMap(now, (failedAt) =>
										recordEvaluationFailure(
											row,
											{ message: "Internal error while evaluating this rule" },
											"defect",
											{
												kind: "other",
												durationMs: failedAt - startedAt,
												claimedAt: timestamp,
											},
										),
									),
								),
							),
						),
					)

				// Rolling pool: a lane that frees pulls the next claimed rule, and the
				// next chunk is claimed only when the current one is fully handed out.
				// Lock ages stay bounded by a chunk's queueing, as before, but one slow
				// rule no longer idles the other lanes until its chunk drains.
				// Space rule starts across the spread so a tick is not one warehouse CPU burst.
				// Windows snap to the minute, so a later start reads the same data; a tick that
				// starts late gets a shorter spread, never deferrals.
				const spreadStart = yield* now
				const spreadMs = Math.max(
					0,
					Math.min(runtime.schedulerSpreadMs(), deadline - SCHEDULER_SPREAD_TAIL_MS - spreadStart),
				)
				const startSpacingMs = dueRows.length > 0 ? spreadMs / dueRows.length : 0
				yield* Effect.annotateCurrentSpan("maple.alerting.spread_ms", Math.round(spreadMs))
				const waitForStartSlot = (index: number) =>
					Effect.flatMap(now, (time) => {
						const waitMs = spreadStart + index * startSpacingMs - time
						return waitMs > 0 ? Effect.sleep(Duration.millis(waitMs)) : Effect.void
					})

				yield* Stream.fromIterable(
					Arr.chunksOf(
						interleaveAlertRulesByOrg(orderAlertRulesByLastClaim(dueRows, lastClaimedAt)),
						lane.claimChunkSize,
					),
				).pipe(
					Stream.mapEffect((chunk) =>
						Effect.gen(function* () {
							const timestamp = yield* now
							if (timestamp >= deadline) {
								yield* deferRules(chunk.length)
								yield* retryUnclaimed(chunk)
								return []
							}
							// A failed claim skips this chunk; its rules are claimed next tick.
							const skipChunk = (cause: Cause.Cause<unknown>) =>
								Effect.logError("Alert rule chunk claim failed").pipe(
									Effect.annotateLogs({
										chunkSize: chunk.length,
										cause: summarizeCause(cause),
									}),
									Effect.andThen(deferRules(chunk.length)),
									Effect.andThen(retryUnclaimed(chunk)),
									Effect.as([]),
								)
							const claimed = yield* claimRuleChunk(chunk, timestamp, lane.lockTtlMs).pipe(
								Effect.catch((error) => skipChunk(Cause.fail(error))),
								Effect.catchDefect((defect) => skipChunk(Cause.die(defect))),
							)
							const claimedIds = new Set(claimed.map((row) => row.id))
							return chunk
								.filter((row) => claimedIds.has(row.id))
								.map((row) => ({ row, timestamp }))
						}),
					),
					Stream.flattenIterable,
					// One at a time, so the next chunk is claimed only when its first rule's slot comes up.
					Stream.mapEffect((claimed, index) => Effect.as(waitForStartSlot(index), claimed)),
					Stream.mapEffect(
						({ row, timestamp }) =>
							Effect.flatMap(now, (startedAt) =>
								startedAt + lane.startRoomMs(row) >= deadline
									? deferRules(1).pipe(
											Effect.andThen(
												Ref.update(
													retryClaims,
													Chunk.append({ id: row.id, timestamp }),
												),
											),
										)
									: evaluateClaimedRule(row, timestamp, startedAt).pipe(
											Effect.andThen(Ref.update(evaluatedRules, (n) => n + 1)),
										),
							),
						{ concurrency: lane.concurrency, unordered: true },
					),
					Stream.runDrain,
				)

				yield* releaseClaims(Chunk.toReadonlyArray(yield* Ref.get(retryClaims))).pipe(
					Effect.withSpan("AlertsService.releaseClaims"),
				)

				// Every rule's writes are done and its claims released; triage overlaps the tail and
				// is joined before returning, since a fiber that outlives a Worker invocation is cancelled.
				const triages = yield* forkRequestScoped(
					startPendingTriages(Chunk.toReadonlyArray(yield* Ref.get(pendingTriages))),
				)
				const deferred = yield* Ref.get(deferredRules)
				yield* Effect.annotateCurrentSpan("maple.alerting.rules_deferred", deferred)
				if (deferred > 0) {
					yield* Effect.logWarning("Alert scheduler tick deadline reached").pipe(
						Effect.annotateLogs({ workerId, deferredRules: deferred }),
					)
				}

				// One warning per org for a warehouse outage, however many of its rules it hit.
				const unavailable = yield* Ref.get(warehouseUnavailableSkips)
				const unavailableSkipCount = HashMap.reduce(unavailable, 0, (n, entry) => n + entry.rules)
				yield* Effect.annotateCurrentSpan(
					"maple.alerting.rules_skipped_warehouse_unavailable",
					unavailableSkipCount,
				)
				yield* Effect.forEach(
					unavailable,
					([orgId, entry]) =>
						Effect.logWarning("Alert rule evaluations skipped: warehouse unavailable").pipe(
							Effect.annotateLogs({
								workerId,
								orgId,
								skippedRules: entry.rules,
								upstreamStatus: entry.upstreamStatus,
								errorMessage: entry.message,
							}),
						),
					{ discard: true },
				)

				const housekeeping = flushRuleStateHousekeeping(
					Chunk.toReadonlyArray(yield* Ref.get(selfHealTargets)),
					Chunk.toReadonlyArray(yield* Ref.get(clearErrorTargets)),
					tickStart,
					limitFailures,
				).pipe(Effect.withSpan("AlertsService.flushRuleStateHousekeeping"))

				// One card per rule for everything its share held back, in place of
				// the banners themselves. After the whole rule loop, so a rule that
				// broke across forty groups is one digest rather than one per chunk.
				// Best-effort like every other push: a digest is a courtesy, and it
				// must never fail the tick that produced it.
				const digests = Effect.forEach(
					yield* pushBudget.suppressed,
					(rule) =>
						mobilePush
							.notifyIncidentDigest(rule)
							.pipe(Effect.timeout("20 seconds"), Effect.ignoreCause),
					{ concurrency: 4, discard: true },
				).pipe(Effect.withSpan("AlertsService.notifyIncidentDigests"))

				// Monitors created before backing rules existed get theirs; evaluated from the next tick.
				const backfillUptimeRules = uptimeAlerts.backfillRules.pipe(
					Effect.catch((error) =>
						Effect.logWarning("Uptime rule backfill failed").pipe(
							Effect.annotateLogs({ error: error.message }),
						),
					),
				)

				// Resolve stale incidents for disabled rules
				const sweepDisabledRules = Effect.gen(function* () {
					const disabledRulesWithOpenIncidents = yield* dbExecute((db) =>
						db.run(
							PG.from(AlertIncidents, "i")
								.innerJoin(AlertRules, "r", (incident, rule) => incident.ruleId.eq(rule.id))
								.select(($) => ({ ruleId: $.ruleId, orgId: $.orgId }))
								.where(($) => [$.status.eq("open"), $.r.enabled.eq(false)])
								.distinct(),
						),
					)
					yield* Effect.forEach(disabledRulesWithOpenIncidents, ({ ruleId, orgId }) =>
						Effect.gen(function* () {
							const ruleRow = (yield* dbExecute((db) =>
								db.run(
									selectStoredAlertRules()
										.where(($) => [$.id.eq(ruleId)])
										.limit(1),
								),
							))[0]
							if (!ruleRow) return
							const normalized = yield* normalizeRuleRow(ruleRow)
							// Budgeted: a sweep that resolves every incident of every
							// disabled rule is exactly the shape that storms phones.
							yield* resolveStaleIncidents(orgId, normalized.id, normalized, {
								resolveAll: true,
								pushBudget,
							})
						}).pipe(isolate("Disabled alert rule sweep failed", { ruleId, orgId })),
					)
				})

				// The history rows go out on their own fiber so a stalled insert never holds the
				// delivery drain; runSchedulerTick joins it before the tick returns.
				const accumulatedChecks = yield* Ref.getAndSet(pendingChecks, Chunk.empty())
				yield* Ref.set(
					checkIngest,
					Option.some(
						yield* forkRequestScoped(ingestAlertChecks(Chunk.toReadonlyArray(accumulatedChecks))),
					),
				)

				// Every rule's writes are done, and these steps do not read each other's writes:
				// disabled rules are never in the housekeeping lists, and the sweep only resolves,
				// which adds nothing to the digests. Run together; a failure still fails the tick.
				// One lane sweeps, so two lanes never resolve the same disabled rule's incidents.
				const tail = yield* Effect.all(
					Arr.map(
						laneName === "standard"
							? [housekeeping, digests, sweepDisabledRules, backfillUptimeRules]
							: [housekeeping, digests],
						Effect.exit,
					),
					{ concurrency: "unbounded" },
				)
				yield* Effect.forEach(tail, (exit) => exit, { discard: true })

				yield* Fiber.join(triages)

				const evaluatedCount = yield* Ref.get(evaluatedRules)
				yield* Metric.update(AlertingMetrics.rulesEvaluatedTotal, evaluatedCount)
				return {
					evaluatedCount,
					evaluationFailureCount: yield* Ref.get(evaluationFailureCount),
					warehouseUnavailableSkipCount: unavailableSkipCount,
					deferredCount: deferred,
				}
			})

			// Deliveries drain even when evaluation fails, so a broken rule pass
			// never holds back notifications already queued. The failure is raised
			// after the drain.
			const runSchedulerTick = Effect.fn("AlertsService.runSchedulerTick")(function* (
				lane: AlertSchedulerLane = "standard",
			) {
				const tickStart = yield* now
				const checkIngest = yield* Ref.make(Option.none<Fiber.Fiber<number>>())
				const evaluation = yield* Effect.exit(evaluateScheduledRules(lane, checkIngest))
				// The alert_checks ingest runs beside the drain and is joined even when the drain fails,
				// so no write outlives the tick.
				const joinCheckIngest = Effect.flatMap(Ref.get(checkIngest), (fiber) =>
					Option.match(fiber, { onNone: () => Effect.succeed(0), onSome: Fiber.join }),
				)
				// One lane drains: the standard lane runs every minute, and its drain has its own 20s budget.
				const delivery = yield* Effect.exit(
					lane === "standard"
						? processQueuedDeliveries()
						: Effect.succeed({ processedCount: 0, failureCount: 0 }),
				)
				const alertChecksDroppedCount = yield* joinCheckIngest
				yield* Effect.annotateCurrentSpan(
					"maple.alerting.alert_checks_dropped",
					alertChecksDroppedCount,
				)
				const deliveryResult = yield* delivery
				const evaluated = yield* evaluation
				yield* Effect.annotateCurrentSpan("maple.alerting.rules_deferred", evaluated.deferredCount)
				yield* Metric.update(AlertingMetrics.tickDurationMs, (yield* now) - tickStart)
				return {
					...evaluated,
					processedCount: deliveryResult.processedCount,
					deliveryFailureCount: deliveryResult.failureCount,
					alertChecksDroppedCount,
				}
			}, withAlertEvaluationScope)

			// `AlertsService.of(...)` can't be used here — referencing the class inside
			// its own `make` is a TS2506 circular base-expression error.
			return {
				listDestinations: destinations.listDestinations,
				createDestination: destinations.createDestination,
				updateDestination: destinations.updateDestination,
				deleteDestination: destinations.deleteDestination,
				listTelegramChats: destinations.listTelegramChats,
				testDestination: destinations.testDestination,
				listRules: rules.listRules,
				createRule: rules.createRule,
				updateRule,
				deleteRule: rules.deleteRule,
				testRule,
				previewRule,
				listIncidents: readModels.listIncidents,
				getIncident: readModels.getIncident,
				listRuleChecks: readModels.listRuleChecks,
				summarizeRuleChecks: readModels.summarizeRuleChecks,
				listDeliveryEvents: readModels.listDeliveryEvents,
				runSchedulerTick,
			} satisfies AlertsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				ChatAlertPoster.layer,
				LinearIssueTracker.layer,
				MobilePushService.layer,
				OrgClickHouseSettingsService.layer,
				WarehouseQueryService.layer,
				EmailService.layer,
				QueryEngineService.layer,
				AlertDestinationsService.layer,
				AlertReadModelsService.layer,
				AlertRulesService.layer,
				UptimeAlertSource.layer,
			),
		),
	)
}
