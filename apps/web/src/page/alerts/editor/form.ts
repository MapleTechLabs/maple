import { AlertComparator, AlertDestinationId, AlertSeverity, AlertSignalType } from "@maple/domain/http"
import { QueryEngineAlertReducer } from "@maple/domain/query-engine"
import type { RuleFormState } from "@maple/web-data/alerts/form-utils"
import { Schema } from "effect"
import { QueryDraft } from "../../kit/query-builder/draft"

// `RuleFormState` (@maple/web-data/alerts/form-utils) as a Schema, so the editor's draft lives in
// the Model. Arrays are mutable to stay assignable to the shared form helpers.

const Strings = Schema.mutable(Schema.Array(Schema.String))
const DestinationIds = Schema.mutable(Schema.Array(AlertDestinationId))

export const EscalationTier = Schema.Struct({
	threshold: Schema.String,
	recoveryValue: Schema.String,
	destinationIds: DestinationIds,
})

export const RuleForm = Schema.Struct({
	name: Schema.String,
	notes: Schema.String,
	enabled: Schema.Boolean,
	severity: AlertSeverity,
	serviceNames: Strings,
	excludeServiceNames: Strings,
	environments: Strings,
	tags: Strings,
	groupBy: Strings,
	signalType: AlertSignalType,
	comparator: AlertComparator,
	threshold: Schema.String,
	thresholdUpper: Schema.String,
	recoveryValue: Schema.String,
	escalation: Schema.NullOr(EscalationTier),
	windowMinutes: Schema.String,
	evaluationIntervalMinutes: Schema.String,
	minimumSampleCount: Schema.String,
	alertOnNoData: Schema.Boolean,
	consecutiveBreachesRequired: Schema.String,
	breachesOutOf: Schema.String,
	consecutiveHealthyRequired: Schema.String,
	renotifyIntervalMinutes: Schema.String,
	apdexThresholdMs: Schema.String,
	queryBuilderDraft: QueryDraft,
	rawQuerySql: Schema.String,
	rawQueryReducer: QueryEngineAlertReducer,
	destinationIds: DestinationIds,
	notificationTitle: Schema.String,
	notificationBody: Schema.String,
})
export type RuleForm = typeof RuleForm.Type

/** Both directions are checked: a field added to one side fails the build. */
export const asFormState = (form: RuleForm): RuleFormState => form
export const fromFormState = (form: RuleFormState): RuleForm => form
