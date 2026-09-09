import { Effect, Result, Schema } from "effect"
import { foldObservation } from "./hysteresis"
import { makeCloudEvent, CloudEventInvalid, type MapleCloudEvent } from "@maple/eventing-core"

import type {
	AlertComparator,
	AlertEventType,
	AlertEvaluationResult,
	AlertEvaluationStatus,
} from "@maple/domain/http"
export type { AlertComparator, AlertEventType, AlertEvaluationStatus } from "@maple/domain/http"

export interface AlertObservation {
	readonly value: number | null
	readonly sampleCount: number
	readonly hasData: boolean
}

export interface AlertEvaluationPolicy {
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly minimumSampleCount: number
	readonly noDataBehavior: "skip" | "zero"
}

export interface AlertEvaluation extends Pick<
	AlertEvaluationResult,
	"status" | "value" | "sampleCount" | "threshold" | "thresholdUpper" | "comparator" | "reason"
> {
	/** A healthy result derived from an empty window synthesized as zero. */
	readonly derivedFromNoData: boolean
}

export const compareAlertThreshold = (
	value: number,
	comparator: AlertComparator,
	threshold: number,
	thresholdUpper: number | null = null,
): boolean => {
	switch (comparator) {
		case "gt":
			return value > threshold
		case "gte":
			return value >= threshold
		case "lt":
			return value < threshold
		case "lte":
			return value <= threshold
		case "eq":
			return value === threshold
		case "neq":
			return value !== threshold
		case "between":
			return thresholdUpper != null && value >= threshold && value <= thresholdUpper
		case "not_between":
			return thresholdUpper != null && (value < threshold || value > thresholdUpper)
	}
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
			derivedFromNoData: false,
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
			derivedFromNoData: false,
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
			derivedFromNoData: false,
		}
	}

	return {
		status: compareAlertThreshold(value, policy.comparator, policy.threshold, policy.thresholdUpper)
			? "breached"
			: "healthy",
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
	readonly consecutiveHealthyRequired: number
	readonly renotifyIntervalMinutes: number
}

export interface AlertLifecycleState {
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
}

export interface AlertLifecycleIncident {
	readonly firstTriggeredAtMs: number
	readonly lastNotifiedAtMs: number | null
	readonly lastDeliveredEventType: AlertEventType | null
}

export type AlertIncidentTransition = "none" | "opened" | "continued" | "resolved"
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
	readonly state: AlertLifecycleState | null
	readonly openIncident: AlertLifecycleIncident | null
	readonly nowMs: number
	/** Most recent notification for a resolved incident with the same rule and group. */
	readonly previousNotificationAtMs?: number | null
	/** Set only after the host's telemetry-query adapter proves data is still arriving. */
	readonly allowNoDataResolution?: boolean
}

export interface AlertLifecyclePlan {
	readonly state: AlertLifecycleState
	readonly transition: AlertIncidentTransition
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

const noTransition = (state: AlertLifecycleState, hold: AlertLifecycleHold = null): AlertLifecyclePlan => ({
	state,
	transition: "none",
	eventType: null,
	notificationSuppression: null,
	hold,
	inheritedNotificationAtMs: null,
	advanceNotificationAnchor: false,
})

/**
 * Decide the next alert state and lifecycle intent without performing I/O.
 *
 * The caller owns persistence, incident identifiers, delivery, telemetry
 * liveness checks, and time. This makes the same lifecycle semantics usable by
 * the hosted PostgreSQL/Tinybird adapter and a future Maple Local adapter.
 */
export const planAlertLifecycle = (input: AlertLifecycleInput): Effect.Effect<AlertLifecyclePlan> =>
	Effect.gen(function* () {
		const { evaluation, policy, openIncident, nowMs } = input
		const previous = input.state ?? { consecutiveBreaches: 0, consecutiveHealthy: 0 }

		if (evaluation.status === "skipped") return noTransition(previous)

		const folded = yield* foldObservation(
			{ ...previous, incidentOpen: openIncident !== null, lastResolvedAtMs: null },
			evaluation.status,
			{
				breachesToOpen: policy.consecutiveBreachesRequired,
				healthyToResolve: policy.consecutiveHealthyRequired,
				cooldownMs: 0,
			},
			nowMs,
		)
		const state: AlertLifecycleState = {
			consecutiveBreaches: folded.consecutiveBreaches,
			consecutiveHealthy: folded.consecutiveHealthy,
		}

		if (
			evaluation.status === "breached" &&
			openIncident == null &&
			state.consecutiveBreaches >= policy.consecutiveBreachesRequired
		) {
			const previousNotificationAtMs = input.previousNotificationAtMs ?? null
			const flapSuppressed =
				previousNotificationAtMs != null &&
				previousNotificationAtMs >= nowMs - policy.renotifyIntervalMinutes * 60_000
			return {
				state,
				transition: "opened",
				eventType: flapSuppressed ? null : "trigger",
				notificationSuppression: flapSuppressed ? "flapping" : null,
				hold: null,
				inheritedNotificationAtMs: flapSuppressed ? previousNotificationAtMs : null,
				advanceNotificationAnchor: false,
			}
		}

		if (evaluation.status === "breached" && openIncident != null) {
			const renotifyDueAt =
				(openIncident.lastNotifiedAtMs ?? openIncident.firstTriggeredAtMs) +
				policy.renotifyIntervalMinutes * 60_000
			const renotifyDue = renotifyDueAt <= nowMs
			return {
				state,
				transition: "continued",
				eventType: renotifyDue ? "renotify" : null,
				notificationSuppression: null,
				hold: null,
				inheritedNotificationAtMs: null,
				advanceNotificationAnchor: renotifyDue,
			}
		}

		if (
			evaluation.status === "healthy" &&
			openIncident != null &&
			state.consecutiveHealthy >= policy.consecutiveHealthyRequired
		) {
			if (evaluation.derivedFromNoData && input.allowNoDataResolution !== true) {
				return noTransition(state, "missing_telemetry")
			}

			const flapResolutionSuppressed =
				openIncident.lastDeliveredEventType == null && openIncident.lastNotifiedAtMs != null
			return {
				state,
				transition: "resolved",
				eventType: flapResolutionSuppressed ? null : "resolve",
				notificationSuppression: flapResolutionSuppressed ? "flap_resolution" : null,
				hold: null,
				inheritedNotificationAtMs: null,
				advanceNotificationAnchor: false,
			}
		}

		return noTransition(state)
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
