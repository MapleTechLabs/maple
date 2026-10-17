import { Effect, Result, Schema } from "effect"
import {
	appendTick,
	classifyTier,
	countersFromHistory,
	encodeTick,
	maxSeverity,
	nearestSeverity,
	resolveActiveSeverity,
	seedHistory,
	type AlertThresholdTier,
	type AlertTierLevel,
	type TieredHysteresisPolicy,
} from "./tiers"
import { makeCloudEvent, CloudEventInvalid, type MapleCloudEvent } from "@maple/eventing-core"

import type {
	AlertComparator,
	AlertEventType,
	AlertEvaluationResult,
	AlertEvaluationStatus,
	AlertSeverity,
} from "@maple/domain/http"
export type { AlertComparator, AlertEventType, AlertEvaluationStatus } from "@maple/domain/http"
export * from "./tiers"

export interface AlertObservation {
	readonly value: number | null
	readonly sampleCount: number
	readonly hasData: boolean
}

export interface AlertEvaluationPolicy {
	readonly comparator: AlertComparator
	/** The primary (lowest) tier, reported on single-threshold surfaces. */
	readonly threshold: number
	readonly thresholdUpper: number | null
	/** Every tier the value is classified against. */
	readonly tiers: ReadonlyArray<AlertThresholdTier>
	readonly minimumSampleCount: number
	readonly noDataBehavior: "skip" | "zero" | "alert"
}

export interface AlertEvaluation extends Pick<
	AlertEvaluationResult,
	| "status"
	| "value"
	| "sampleCount"
	| "threshold"
	| "thresholdUpper"
	| "comparator"
	| "reason"
	| "skipReason"
> {
	/** Derived from an empty window: healthy when read as zero, breached when the rule alerts on no data. */
	readonly derivedFromNoData: boolean
	/** Per-tier verdict; empty on a skipped tick. */
	readonly levels: ReadonlyArray<AlertTierLevel>
}

export const evaluateAlertObservation = (
	policy: AlertEvaluationPolicy,
	observation: AlertObservation,
	reason: string,
): AlertEvaluation => {
	// Sample-weighted counts can be fractional while durable alert state commonly
	// stores an integer. Normalize at the host-neutral boundary.
	const sampleCount = Math.round(observation.sampleCount)
	const value = observation.hasData
		? observation.value !== null && Number.isFinite(observation.value)
			? observation.value
			: null
		: policy.noDataBehavior === "zero"
			? 0
			: null

	if (!observation.hasData && policy.noDataBehavior === "skip") {
		return {
			status: "skipped",
			value: null,
			sampleCount,
			threshold: policy.threshold,
			thresholdUpper: policy.thresholdUpper,
			comparator: policy.comparator,
			reason: "No data in the selected window",
			skipReason: "no_data",
			derivedFromNoData: false,
			levels: [],
		}
	}

	// The window is empty and the rule asked to hear about it: a breach with no value.
	if (!observation.hasData && policy.noDataBehavior === "alert") {
		return {
			status: "breached",
			value: null,
			sampleCount,
			threshold: policy.threshold,
			thresholdUpper: policy.thresholdUpper,
			comparator: policy.comparator,
			reason: "No data in the selected window",
			derivedFromNoData: true,
			levels: policy.tiers.map((tier) => ({ severity: tier.severity, status: "breach" as const })),
		}
	}

	if (sampleCount < policy.minimumSampleCount) {
		return {
			status: "skipped",
			value,
			sampleCount,
			threshold: policy.threshold,
			thresholdUpper: policy.thresholdUpper,
			comparator: policy.comparator,
			reason: `Sample count ${sampleCount} is below minimum ${policy.minimumSampleCount}`,
			skipReason: "below_min_samples",
			derivedFromNoData: false,
			levels: [],
		}
	}

	if (value == null) {
		return {
			status: "skipped",
			value: null,
			sampleCount,
			threshold: policy.threshold,
			thresholdUpper: policy.thresholdUpper,
			comparator: policy.comparator,
			reason: "Alert evaluation did not return a scalar value",
			skipReason: "no_value",
			derivedFromNoData: false,
			levels: [],
		}
	}

	const levels = policy.tiers.map((tier) => ({
		severity: tier.severity,
		status: classifyTier(value, policy.comparator, tier),
	}))
	return {
		status: levels.some((level) => level.status === "breach") ? "breached" : "healthy",
		levels,
		value,
		sampleCount,
		threshold: policy.threshold,
		thresholdUpper: policy.thresholdUpper,
		comparator: policy.comparator,
		reason,
		derivedFromNoData: !observation.hasData,
	}
}

export interface AlertLifecyclePolicy {
	readonly consecutiveBreachesRequired: number
	/** M in "N of the last M checks"; equal to N for "N in a row". */
	readonly breachWindow: number
	readonly consecutiveHealthyRequired: number
	readonly renotifyIntervalMinutes: number
	/** The rule's tier severities. */
	readonly severities: ReadonlyArray<AlertSeverity>
}

export interface AlertLifecycleState {
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
	/** Recent non-skipped ticks, oldest first; see `encodeTick`. */
	readonly history: ReadonlyArray<number>
}

export interface AlertLifecycleIncident {
	/** The incident's current severity. */
	readonly severity: AlertSeverity
	readonly firstTriggeredAtMs: number
	readonly lastNotifiedAtMs: number | null
	readonly lastDeliveredEventType: AlertEventType | null
}

export type AlertIncidentTransition =
	| "none"
	| "opened"
	| "continued"
	| "escalated"
	| "deescalated"
	| "resolved"
export type AlertNotificationSuppression = "flapping" | "flap_resolution" | null
export type AlertLifecycleHold = "missing_telemetry" | null

export interface AlertLifecycleEventInput {
	readonly tenantId: string
	readonly ruleId: string
	readonly ruleName: string
	readonly incidentId: string | null
	readonly eventType: AlertEventType
	readonly incidentStatus: string
	readonly groupKey: string | null
	readonly signalType: string
	readonly severity: string
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly windowMinutes: number
	readonly value: number | null
	readonly sampleCount: number | null
	readonly occurredAtMs: number
}

/** Identity is stable per scheduled tick; delivery retries reuse the retained envelope. */
export const projectAlertLifecycleEvent = (
	input: AlertLifecycleEventInput,
): Result.Result<MapleCloudEvent, CloudEventInvalid> =>
	Result.gen(function* () {
		const occurredAtMs = yield* Schema.decodeUnknownResult(
			Schema.Int.check(
				Schema.isGreaterThanOrEqualTo(0),
				Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
			),
		)(input.occurredAtMs).pipe(
			Result.mapError(
				(cause) =>
					new CloudEventInvalid({
						message: "alert lifecycle event time is outside the supported date range",
						cause,
					}),
			),
		)
		const occurredAtDate = new Date(occurredAtMs)
		const occurredAt = occurredAtDate.toISOString()
		const occurrenceId = `${input.incidentId ?? input.ruleId}:${input.eventType}:${input.occurredAtMs}`
		return yield* makeCloudEvent({
			signal: {
				sourceKind: "alert.lifecycle",
				source: `urn:maple:alert-rule:${input.ruleId}`,
				tenantId: input.tenantId,
				occurrenceId,
				identityQuality: "source",
				occurredAt,
				observedAt: occurredAt,
				subject:
					input.incidentId === null
						? `alert-rules/${input.ruleId}`
						: `alert-incidents/${input.incidentId}`,
				fields: new Map(),
				data: {},
			},
			projection: {
				id: "alert-lifecycle",
				revision: 1,
				enabled: true,
				tenantId: input.tenantId,
				sourceKind: "alert.lifecycle",
				selector: {
					op: "exists",
					field: { namespace: "signal", key: "event_type", type: "string" },
				},
				projector: { id: "alert.lifecycle", version: 1, config: {} },
				activeFrom: occurredAt,
			},
			projectorId: "alert.lifecycle",
			projectorVersion: 1,
			outputType: `dev.maple.alert.lifecycle.${input.eventType}.v1`,
			dataSchema: "urn:maple:event-schema:alert-lifecycle:v1",
			data: {
				eventType: input.eventType,
				incidentId: input.incidentId,
				incidentStatus: input.incidentStatus,
				rule: {
					id: input.ruleId,
					name: input.ruleName,
					signalType: input.signalType,
					severity: input.severity,
					groupKey: input.groupKey,
					comparator: input.comparator,
					threshold: input.threshold,
					thresholdUpper: input.thresholdUpper,
					windowMinutes: input.windowMinutes,
				},
				observed: { value: input.value, sampleCount: input.sampleCount },
			},
		})
	})

export interface AlertLifecycleInput {
	readonly policy: AlertLifecyclePolicy
	readonly evaluation: AlertEvaluation
	/** Null for a group never evaluated; a null `history` (pre-tier row) is replayed from its counters. */
	readonly state:
		| (Omit<AlertLifecycleState, "history"> & { readonly history?: ReadonlyArray<number> | null })
		| null
	readonly openIncident: AlertLifecycleIncident | null
	readonly nowMs: number
	/** Most recent notification for a resolved incident with the same rule and group. */
	readonly previousNotificationAtMs?: number | null
	/** Set after the host's liveness gate permits recovery, including an expired hold ceiling. */
	readonly allowNoDataResolution?: boolean
}

export interface AlertLifecyclePlan {
	readonly state: AlertLifecycleState
	readonly transition: AlertIncidentTransition
	/** Severity of the open incident after this tick; null when none stands. */
	readonly severity: AlertSeverity | null
	readonly eventType: AlertEventType | null
	readonly notificationSuppression: AlertNotificationSuppression
	readonly hold: AlertLifecycleHold
	/** Notification anchor to copy to a newly opened, flap-suppressed incident. */
	readonly inheritedNotificationAtMs: number | null
	/** Whether the host must advance lastNotifiedAt before queueing the event. */
	readonly advanceNotificationAnchor: boolean
}

export interface AlertDeliveryRetryPolicy {
	readonly maxAttempts: number
	readonly baseDelayMs: number
	readonly maxDelayMs: number
}

export const DEFAULT_ALERT_DELIVERY_RETRY_POLICY: AlertDeliveryRetryPolicy = {
	maxAttempts: 5,
	baseDelayMs: 60_000,
	maxDelayMs: 15 * 60_000,
}

/** Stable idempotency key shared by every alert delivery adapter. */
export const makeAlertDeliveryKey = (
	incidentId: string,
	destinationId: string,
	eventType: AlertEventType,
	scheduledAtMs: number,
): string => [incidentId, destinationId, eventType, scheduledAtMs].join(":")

export const canRetryAlertDelivery = (
	attemptNumber: number,
	retryable: boolean,
	policy: AlertDeliveryRetryPolicy = DEFAULT_ALERT_DELIVERY_RETRY_POLICY,
): boolean => retryable && attemptNumber < policy.maxAttempts

/** Exponential retry delay; the host supplies jitter from its own random source. */
export const alertDeliveryRetryDelayMs = (
	attemptNumber: number,
	jitterMs: number,
	policy: AlertDeliveryRetryPolicy = DEFAULT_ALERT_DELIVERY_RETRY_POLICY,
): number => {
	const exponent = Math.max(0, attemptNumber - 1)
	const base = Math.min(policy.baseDelayMs * Math.pow(2, exponent), policy.maxDelayMs)
	return base + Math.max(0, Math.floor(jitterMs))
}

const noTransition = (
	state: AlertLifecycleState,
	severity: AlertSeverity | null,
	hold: AlertLifecycleHold = null,
): AlertLifecyclePlan => ({
	state,
	transition: "none",
	severity,
	eventType: null,
	notificationSuppression: null,
	hold,
	inheritedNotificationAtMs: null,
	advanceNotificationAnchor: false,
})

const resolutionPlan = (
	state: AlertLifecycleState,
	openIncident: AlertLifecycleIncident,
): AlertLifecyclePlan => {
	const flapResolutionSuppressed =
		openIncident.lastDeliveredEventType == null && openIncident.lastNotifiedAtMs != null
	return {
		state,
		transition: "resolved",
		severity: null,
		eventType: flapResolutionSuppressed ? null : "resolve",
		notificationSuppression: flapResolutionSuppressed ? "flap_resolution" : null,
		hold: null,
		inheritedNotificationAtMs: null,
		advanceNotificationAnchor: false,
	}
}

/**
 * Decide the next alert state and lifecycle intent without performing I/O.
 *
 * The caller owns persistence, incident identifiers, delivery, telemetry
 * liveness checks, and time. This makes the same lifecycle semantics usable by
 * the hosted PostgreSQL/Tinybird adapter and a future Maple Local adapter.
 */
export const planAlertLifecycle = (input: AlertLifecycleInput): Effect.Effect<AlertLifecyclePlan> =>
	Effect.sync(() => {
		const { evaluation, policy, openIncident, nowMs } = input
		const current =
			openIncident === null ? null : nearestSeverity(openIncident.severity, policy.severities)
		const hysteresis: TieredHysteresisPolicy = {
			breachesToOpen: policy.consecutiveBreachesRequired,
			breachWindow: policy.breachWindow,
			healthyToResolve: policy.consecutiveHealthyRequired,
		}
		const counters = input.state ?? { consecutiveBreaches: 0, consecutiveHealthy: 0, history: [] }
		const seedSeverity =
			current ??
			policy.severities.reduce<AlertSeverity>((highest, s) => maxSeverity(highest, s) ?? s, "warning")
		const previous: AlertLifecycleState = {
			consecutiveBreaches: counters.consecutiveBreaches,
			consecutiveHealthy: counters.consecutiveHealthy,
			history: counters.history ?? seedHistory(counters, seedSeverity, hysteresis),
		}

		if (evaluation.status === "skipped") {
			// Empty skipped windows use the same host liveness gate as missing
			// groups. Other skips freeze the incident without probing or resolving.
			if (evaluation.skipReason === "no_data" && openIncident !== null) {
				return input.allowNoDataResolution === true
					? resolutionPlan(previous, openIncident)
					: noTransition(previous, current, "missing_telemetry")
			}
			return noTransition(previous, current)
		}

		const history = appendTick(previous.history, encodeTick(evaluation.levels), hysteresis)
		const state: AlertLifecycleState = { ...countersFromHistory(history, hysteresis), history }
		const next = resolveActiveSeverity(history, policy.severities, current, hysteresis)

		if (openIncident === null) {
			if (next === null) return noTransition(state, null)
			const previousNotificationAtMs = input.previousNotificationAtMs ?? null
			const flapSuppressed =
				previousNotificationAtMs != null &&
				previousNotificationAtMs >= nowMs - policy.renotifyIntervalMinutes * 60_000
			return {
				state,
				transition: "opened",
				severity: next,
				eventType: flapSuppressed ? null : "trigger",
				notificationSuppression: flapSuppressed ? "flapping" : null,
				hold: null,
				inheritedNotificationAtMs: flapSuppressed ? previousNotificationAtMs : null,
				advanceNotificationAnchor: false,
			}
		}

		if (next === null) {
			if (evaluation.derivedFromNoData && input.allowNoDataResolution !== true) {
				return noTransition(state, current, "missing_telemetry")
			}
			return resolutionPlan(state, openIncident)
		}

		// A severity change is news: escalation pages like a trigger, de-escalation
		// reads as a reminder at the lower severity. Both restart the reminder clock.
		// A tier moved by a rule edit (next === current) is announced on its first breaching tick.
		if (next !== openIncident.severity && (next !== current || evaluation.status === "breached")) {
			const escalated = maxSeverity(next, openIncident.severity) === next
			return {
				state,
				transition: escalated ? "escalated" : "deescalated",
				severity: next,
				eventType: escalated ? "trigger" : "renotify",
				notificationSuppression: null,
				hold: null,
				inheritedNotificationAtMs: null,
				advanceNotificationAnchor: true,
			}
		}

		if (evaluation.status === "breached") {
			const renotifyDueAt =
				(openIncident.lastNotifiedAtMs ?? openIncident.firstTriggeredAtMs) +
				policy.renotifyIntervalMinutes * 60_000
			const renotifyDue = renotifyDueAt <= nowMs
			return {
				state,
				transition: "continued",
				severity: next,
				eventType: renotifyDue ? "renotify" : null,
				notificationSuppression: null,
				hold: null,
				inheritedNotificationAtMs: null,
				advanceNotificationAnchor: renotifyDue,
			}
		}

		return noTransition(state, next)
	})

/** Preserve per-tenant order while preventing one tenant from monopolizing a tick. */
export const interleaveAlertRulesByTenant = <T>(
	rows: ReadonlyArray<T>,
	tenantIdOf: (row: T) => string,
): ReadonlyArray<T> => {
	const queues = new Map<string, T[]>()
	for (const row of rows) {
		const tenantId = tenantIdOf(row)
		const queue = queues.get(tenantId)
		if (queue) queue.push(row)
		else queues.set(tenantId, [row])
	}

	const fair: T[] = []
	let index = 0
	while (fair.length < rows.length) {
		for (const queue of queues.values()) {
			const row = queue[index]
			if (row !== undefined) fair.push(row)
		}
		index += 1
	}
	return fair
}
