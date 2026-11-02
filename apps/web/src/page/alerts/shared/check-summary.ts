import {
	AlertCheckDocument,
	type AlertIncidentDocument,
	type AlertRuleDocument,
	AlertRuleId,
	IsoDateTimeString,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { isoMs } from "./time"

// The evaluator's own record of a rule, bucketed: what the scheduler observed, not a replay.

/** `alertRules.checksSummary`: per-bucket check tallies plus the window totals. */
export const CheckSummary = Schema.Struct({
	bucketSeconds: Schema.Number,
	totals: Schema.Struct({
		total: Schema.Number,
		breached: Schema.Number,
		healthy: Schema.Number,
		skipped: Schema.Number,
		error: Schema.Number,
		transitions: Schema.Number,
	}),
	points: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			groupKey: Schema.String,
			totalCount: Schema.Number,
			breachedCount: Schema.Number,
			healthyCount: Schema.Number,
			skippedCount: Schema.Number,
			errorCount: Schema.Number,
			transitionCount: Schema.Number,
			observedValue: Schema.NullOr(Schema.Number),
			threshold: Schema.Number,
		}),
	),
})
export type CheckSummary = typeof CheckSummary.Type

export const fetchCheckSummary = (ruleId: AlertRuleId, since: IsoDateTimeString, until: IsoDateTimeString) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const summary = yield* client.alertRules.checksSummary({
			params: { id: ruleId },
			query: { since, until },
		})
		return {
			bucketSeconds: summary.bucket_seconds,
			totals: summary.totals,
			points: summary.points.map((point) => ({
				bucket: point.bucket,
				groupKey: point.group_key,
				totalCount: point.total_count,
				breachedCount: point.breached_count,
				healthyCount: point.healthy_count,
				skippedCount: point.skipped_count,
				errorCount: point.error_count,
				transitionCount: point.transition_count,
				observedValue: point.observed_value,
				threshold: point.threshold,
			})),
		} satisfies CheckSummary
	})

/** The summary buckets read as checks, one per (bucket, group), for the chart and its rail. */
export const summaryChecksOf = (
	rule: AlertRuleDocument,
	summary: CheckSummary,
): ReadonlyArray<AlertCheckDocument> =>
	summary.points.map((point) => {
		const status: AlertCheckDocument["status"] =
			point.errorCount > 0
				? "error"
				: point.breachedCount > 0
					? "breached"
					: point.healthyCount > 0
						? "healthy"
						: "skipped"
		const bucketStart = IsoDateTimeString.make(point.bucket)
		const bucketEnd = IsoDateTimeString.make(
			new Date(isoMs(point.bucket) + summary.bucketSeconds * 1000).toISOString(),
		)
		return new AlertCheckDocument({
			timestamp: bucketStart,
			groupKey: point.groupKey,
			status,
			skipReason: null,
			signalType: rule.signalType,
			comparator: rule.comparator,
			threshold: point.threshold,
			thresholdUpper: rule.thresholdUpper,
			observedValue: point.observedValue,
			sampleCount: point.totalCount,
			windowMinutes: Math.max(1, Math.round(summary.bucketSeconds / 60)),
			windowStart: bucketStart,
			windowEnd: bucketEnd,
			consecutiveBreaches: 0,
			consecutiveHealthy: 0,
			incidentId: null,
			incidentTransition: point.transitionCount > 0 ? "continued" : "none",
			level: null,
			evaluationDurationMs: 0,
			errorMessage: null,
			errorCategory: null,
		})
	})

/** A grouped rule records every group; the incident is about one of them. */
export const incidentChecksOf = (
	checks: ReadonlyArray<AlertCheckDocument>,
	incident: AlertIncidentDocument,
): ReadonlyArray<AlertCheckDocument> => {
	if (incident.groupKey == null) return checks
	const own = checks.filter((check) => check.groupKey === incident.groupKey)
	return own.length === 0 ? checks : own
}
