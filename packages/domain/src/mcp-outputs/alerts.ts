/** Output schemas for the alerts MCP tools. */
import { Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/query-model"
import { OutputTimeRange } from "./shared"

const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)

export const AlertRuleRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
	severity: Schema.String,
	serviceNames: Schema.Array(Schema.String),
	/** Deployment environments the rule is scoped to. Empty means all. */
	environments: Schema.Array(Schema.String),
	signalType: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	windowMinutes: Schema.Number,
	destinationIds: Schema.Array(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
})

export const ListAlertRulesOutput = Schema.Struct({
	rules: Schema.Array(AlertRuleRow),
	total: Schema.Number,
	/** The filters that applied, echoed for the rendered scope. */
	services: Schema.optionalKey(Schema.Array(Schema.String)),
	signalType: Schema.optionalKey(Schema.String),
	severity: Schema.optionalKey(Schema.String),
	enabledOnly: Schema.optionalKey(Schema.Boolean),
})

export const AlertDestinationRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	type: Schema.String,
	enabled: Schema.Boolean,
	summary: Schema.String,
	channelLabel: NullableString,
	lastTestedAt: NullableString,
	lastTestError: NullableString,
	disabledReason: NullableString,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})

export const ListAlertDestinationsOutput = Schema.Struct({
	destinations: Schema.Array(AlertDestinationRow),
	total: Schema.Number,
	type: Schema.optionalKey(Schema.String),
	enabledOnly: Schema.optionalKey(Schema.Boolean),
})

export const CreateAlertRuleOutput = Schema.Struct({ rule: AlertRuleRow })

export const UpdateAlertRuleOutput = Schema.Struct({ rule: AlertRuleRow })

export const DeleteAlertRuleOutput = Schema.Struct({ id: Schema.String })

export const AlertRuleDetailRow = Schema.Struct({
	...AlertRuleRow.fields,
	excludeServiceNames: Schema.Array(Schema.String),
	groupBy: Schema.NullOr(Schema.Array(Schema.String)),
	minimumSampleCount: Schema.Number,
	consecutiveBreachesRequired: Schema.Number,
	consecutiveHealthyRequired: Schema.Number,
	renotifyIntervalMinutes: Schema.Number,
	apdexThresholdMs: NullableNumber,
	queryBuilderDraft: Schema.NullOr(QueryBuilderQueryDraftSchema),
	rawQuerySql: NullableString,
	rawQueryReducer: NullableString,
	/** Upper bound for the `between` / `not_between` comparators. */
	thresholdUpper: Schema.optionalKey(NullableNumber),
	notificationTitle: Schema.optionalKey(NullableString),
	notificationBody: Schema.optionalKey(NullableString),
	/** Most recent evaluation failure, if the rule's last check errored. */
	lastEvaluationError: Schema.optionalKey(NullableString),
	lastEvaluatedAt: Schema.optionalKey(NullableString),
})

export const GetAlertRuleOutput = Schema.Struct({ rule: AlertRuleDetailRow })

export const AlertIncidentRow = Schema.Struct({
	id: Schema.String,
	ruleId: Schema.String,
	ruleName: Schema.String,
	groupKey: NullableString,
	signalType: Schema.String,
	severity: Schema.String,
	status: Schema.String,
	/** Set while an open incident is waiting on telemetry rather than observing a breach. */
	holdReason: NullableString,
	heldSince: NullableString,
	threshold: Schema.Number,
	comparator: Schema.String,
	firstTriggeredAt: Schema.String,
	resolvedAt: NullableString,
	lastObservedValue: NullableNumber,
})

/** Filters an incident list was narrowed by, echoed for the rendered scope. */
const IncidentFilters = {
	status: Schema.optionalKey(Schema.String),
	severity: Schema.optionalKey(Schema.String),
	groupKey: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Number),
	/** More incidents matched than `limit` let through. */
	hasMore: Schema.optionalKey(Schema.Boolean),
}

export const ListAlertIncidentsOutput = Schema.Struct({
	incidents: Schema.Array(AlertIncidentRow),
	total: Schema.Number,
	openCount: Schema.Number,
	resolvedCount: Schema.Number,
	...IncidentFilters,
})

export const AlertCheckRow = Schema.Struct({
	timestamp: Schema.String,
	groupKey: Schema.String,
	status: Schema.String,
	observedValue: NullableNumber,
	threshold: Schema.Number,
	comparator: Schema.String,
	sampleCount: Schema.Number,
	windowStart: Schema.String,
	windowEnd: Schema.String,
	consecutiveBreaches: Schema.Number,
	consecutiveHealthy: Schema.Number,
	incidentId: NullableString,
	incidentTransition: Schema.String,
	evaluationDurationMs: Schema.Number,
	errorMessage: NullableString,
	errorCategory: NullableString,
})

export const ListAlertChecksOutput = Schema.Struct({
	ruleId: Schema.String,
	total: Schema.Number,
	breached: Schema.Number,
	healthy: Schema.Number,
	skipped: Schema.Number,
	errored: Schema.Number,
	transitions: Schema.Number,
	checks: Schema.Array(AlertCheckRow),
	timeRange: Schema.optionalKey(OutputTimeRange),
	groupKey: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Number),
})

export const IncidentTimelineRow = Schema.Struct({
	id: Schema.String,
	ruleId: Schema.String,
	ruleName: Schema.String,
	groupKey: NullableString,
	signalType: Schema.String,
	severity: Schema.String,
	status: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	lastObservedValue: NullableNumber,
	firstTriggeredAt: Schema.String,
	lastTriggeredAt: Schema.String,
	resolvedAt: NullableString,
	lastNotifiedAt: NullableString,
})

export const GetIncidentTimelineOutput = Schema.Struct({
	incidents: Schema.Array(IncidentTimelineRow),
	total: Schema.Number,
	openCount: Schema.Number,
	resolvedCount: Schema.Number,
	ruleId: Schema.optionalKey(Schema.String),
	...IncidentFilters,
})
