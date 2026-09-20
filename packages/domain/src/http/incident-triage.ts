/**
 * The pre-LLM triage verdict.
 *
 * A decision model (TypeSafe's Jev, through OpenRouter) reads the incident
 * snapshot and answers three bounded questions before an investigation spends a
 * model pass on it: what this is, how bad it is, and whether anyone would
 * notice. It is not an agent turn and must never become one — see CLAUDE.md on
 * the one-turn investigation.
 */
import { Schema } from "effect"
import { IssueSeverity } from "./errors"

/**
 * What the incident deserves.
 *
 * `monitor` exists so `noise` can stay sharp: without a middle label, every
 * real-but-unremarkable incident has to be filed as one of the two extremes,
 * and the one that skips work is the one that fills up.
 */
export const IncidentDisposition = Schema.Literals(["investigate", "monitor", "noise"]).annotate({
	identifier: "@maple/IncidentDisposition",
	title: "Incident Disposition",
})
export type IncidentDisposition = Schema.Schema.Type<typeof IncidentDisposition>

/** A probability the decision model returned, `0` to `1` inclusive. */
export const TriageProbability = Schema.Finite.check(
	Schema.isBetween({ minimum: 0, maximum: 1 }),
).annotate({ identifier: "@maple/TriageProbability", title: "Triage Probability" })

export class IncidentTriageVerdict extends Schema.Class<IncidentTriageVerdict>(
	"IncidentTriageVerdict",
)({
	disposition: IncidentDisposition,
	/** The model's own probability for the disposition it chose. */
	dispositionConfidence: TriageProbability,
	/** Severity on the same four-value scale the rest of the product uses. */
	severity: IssueSeverity,
	severityConfidence: TriageProbability,
	/** How likely a customer noticed. Kept whole: a gate may want it later. */
	userImpact: TriageProbability,
	/** The model id that answered, so a verdict stays readable after a model change. */
	model: Schema.String,
}) {}

/** The request half: what the classifier is given to judge. */
export class IncidentTriageRequest extends Schema.Class<IncidentTriageRequest>(
	"IncidentTriageRequest",
)({
	title: Schema.String,
	incidentKind: Schema.String,
	/** The detector's severity, when it set one. The model may disagree. */
	detectorSeverity: Schema.NullOr(IssueSeverity),
	serviceName: Schema.NullOr(Schema.String),
	deploymentEnv: Schema.NullOr(Schema.String),
	exceptionType: Schema.NullOr(Schema.String),
	exceptionMessage: Schema.NullOr(Schema.String),
	topFrame: Schema.NullOr(Schema.String),
	occurrenceCount: Schema.NullOr(Schema.Number),
	signalType: Schema.NullOr(Schema.String),
	observedValue: Schema.NullOr(Schema.Number),
	thresholdValue: Schema.NullOr(Schema.Number),
}) {}
