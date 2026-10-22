import {
	AlertDestinationDocument,
	EscalationConfidence,
	EscalationPolicyEvaluationDocument,
	IssueEscalationAttemptsResponse,
	IssueEscalationPolicyDocument,
	IssueSeverity,
} from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Select from "../../../ui/select"

// `AutomationSection` and `EscalationPolicySection` (apps/web/src/components/settings/).

export const ConfidenceChoice = Schema.Literals(["any", "low", "medium", "high"])
export type ConfidenceChoice = typeof ConfidenceChoice.Type

export const RuleDraft = Schema.Struct({
	destinationIds: Schema.Array(Schema.String),
	minConfidence: ConfidenceChoice,
})
export type RuleDraft = typeof RuleDraft.Type
export const PolicyDraft = Schema.Struct({
	enabled: Schema.Boolean,
	critical: RuleDraft,
	high: RuleDraft,
	medium: RuleDraft,
	low: RuleDraft,
})
export type PolicyDraft = typeof PolicyDraft.Type

export const PolicyData = AsyncData.Schema(IssueEscalationPolicyDocument, LoadFailure)
export const AttemptsData = AsyncData.Schema(IssueEscalationAttemptsResponse, LoadFailure)

export const DecisionSource = Schema.Literals(["ai", "manual"])
export type DecisionSource = typeof DecisionSource.Type

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	policy: PolicyData.schema,
	/** The editable policy, `null` until the stored one loads (never a default over a failed load). */
	draft: Schema.NullOr(PolicyDraft),
	isDirty: Schema.Boolean,
	/** Bumped on every edit: a decision evaluated before it is never shown after. */
	revision: Schema.Number,
	isSaving: Schema.Boolean,
	confidenceSelects: Schema.Record(Schema.String, Select.Model),
	/** `useAlertDestinationsList()`, `null` until the shape answers. */
	destinations: Schema.NullOr(Schema.Array(AlertDestinationDocument)),
	brokenLogos: Schema.Array(Schema.String),
	severitySelect: Select.Model,
	source: DecisionSource,
	confidence: EscalationConfidence,
	evaluated: Schema.NullOr(
		Schema.Struct({ revision: Schema.Number, decision: EscalationPolicyEvaluationDocument }),
	),
	isEvaluating: Schema.Boolean,
	attempts: AttemptsData.schema,
})
export type Model = typeof Model.Type

const done = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchPolicy: done(IssueEscalationPolicyDocument),
	CompletedFetchAttempts: done(IssueEscalationAttemptsResponse),
	UpdatedDestinations: { destinations: Schema.Array(AlertDestinationDocument) },
	FailedLoadProviderLogo: { type: Schema.String },
	ClickedRetryPolicy: {},
	ToggledEnabled: {},
	GotConfidenceSelectMessage: { severity: IssueSeverity, message: Select.Message },
	ToggledDestination: { severity: IssueSeverity, destinationId: Schema.String },
	ClickedSavePolicy: {},
	CompletedSavePolicy: done(IssueEscalationPolicyDocument),
	GotSeveritySelectMessage: { message: Select.Message },
	ChangedSource: { value: Schema.String },
	ChangedConfidence: { value: Schema.String },
	ClickedEvaluate: {},
	CompletedEvaluate: { revision: Schema.Number, ...done(EscalationPolicyEvaluationDocument) },
})
export type Message = typeof Message.Type
