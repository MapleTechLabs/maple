// The hidden `audit` alert rule behind each audit log detection, and how its row reads back.
import { AuditDetectionFilters } from "@maple/domain/audit-trail"
import {
	AlertSeverity,
	AlertThresholds,
	type AlertDestinationId,
	type AlertRuleId,
	type AuditDetection,
} from "@maple/domain/http"
import { Array as Arr, Option, Schema } from "effect"
import { MANAGED_RULE_PLAN } from "@maple/backend/services/alerts/AlertRuleModel"

export interface AuditDetectionRuleInput {
	readonly name: string
	readonly enabled: boolean
	readonly filters: AuditDetectionFilters
	readonly windowMinutes: number
	readonly threshold: number
	readonly severity: AlertSeverity
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
}

/**
 * The `alert_rules` columns of a detection's rule: one tier at the event count, checked every
 * minute. One check at the count opens and one below it resolves: the window already smooths
 * it, and a day between reminders keeps a long-running match from paging every half hour.
 */
export const auditDetectionRuleFields = (input: AuditDetectionRuleInput) => {
	const thresholds: AlertThresholds = [
		{
			severity: input.severity,
			value: input.threshold,
			upper: null,
			recoveryValue: null,
			destinationIds: [...input.destinationIds],
		},
	]
	return {
		name: input.name,
		notes: null,
		notificationTemplateJson: null,
		enabled: input.enabled,
		severity: input.severity,
		serviceNamesJson: null,
		excludeServiceNamesJson: null,
		environmentsJson: null,
		auditFiltersJson: input.filters,
		tagsJson: null,
		groupBy: null,
		signalType: "audit",
		comparator: "gte",
		threshold: input.threshold,
		thresholdUpper: null,
		thresholdsJson: thresholds,
		windowMinutes: input.windowMinutes,
		evaluationIntervalMinutes: 1,
		slowedIntervalMinutes: null,
		slowedAt: null,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 1,
		breachesOutOf: null,
		consecutiveHealthyRequired: 1,
		renotifyIntervalMinutes: 1440,
		apdexThresholdMs: null,
		queryBuilderDraftJson: null,
		rawQuerySql: null,
		destinationIdsJson: [...input.destinationIds],
		querySpecJson: null,
		reducer: MANAGED_RULE_PLAN.reducer,
		sampleCountStrategy: null,
		noDataBehavior: MANAGED_RULE_PLAN.noDataBehavior,
	} as const
}

/** The columns a detection reads back from; the jsonb ones undecoded, so one bad row fails alone. */
export interface AuditDetectionRuleRow {
	readonly id: AlertRuleId
	readonly name: string
	readonly enabled: boolean
	readonly auditFiltersJson: unknown
	readonly windowMinutes: number
	readonly threshold: number
	readonly thresholdsJson: unknown
	readonly createdAt: number
	readonly updatedAt: number
}

const decodeFilters = Schema.decodeUnknownOption(AuditDetectionFilters)
const decodeThresholds = Schema.decodeUnknownOption(AlertThresholds)

/**
 * A stored rule as the detection it is. None when its tier or filters do not read: showing a
 * guess would let a save overwrite what is stored. No filters column counts every event.
 */
export const auditDetectionFromRow = (row: AuditDetectionRuleRow): Option.Option<AuditDetection> =>
	Option.all({
		filters: row.auditFiltersJson == null ? Option.some({}) : decodeFilters(row.auditFiltersJson),
		tier: Option.flatMap(decodeThresholds(row.thresholdsJson), Arr.head),
	}).pipe(
		Option.map(({ filters, tier }) => ({
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			filters,
			windowMinutes: row.windowMinutes,
			threshold: row.threshold,
			severity: tier.severity,
			destinationIds: tier.destinationIds,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		})),
	)

const formatMinutes = (minutes: number) => (minutes === 1 ? "minute" : `${minutes} minutes`)

/** What one check of a detection saw, as the incident and its notifications say it. */
export const auditCountReason = (count: number, windowMinutes: number): string =>
	`${count} matching audit ${count === 1 ? "event" : "events"} in the last ${formatMinutes(windowMinutes)}`
