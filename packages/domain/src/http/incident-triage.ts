/**
 * The pre-LLM triage verdict.
 *
 * A decision model (TypeSafe's Jev, through OpenRouter) reads the incident
 * snapshot and answers bounded questions before an investigation spends a
 * model pass on it: what this is, how bad it is, whether anyone would notice,
 * and whether a diagnosis already on file explains it. It is not an agent turn
 * and must never become one — see CLAUDE.md on the one-turn investigation.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InvestigationId } from "../primitives"
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
export const TriageProbability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
	identifier: "@maple/TriageProbability",
	title: "Triage Probability",
})

/**
 * How many recent diagnoses the classifier is shown. Enough to cover a service's
 * open issues, few enough that the question stays one question.
 */
export const PRIOR_DIAGNOSES_LIMIT = 8

/**
 * A diagnosis already on file for the same service, offered to the classifier so
 * a flare-up of a known cause under a new fingerprint is recognised instead of
 * investigated again. Measured on the internal org 2026-09-15..20: one CLI
 * defect surfaced under ten fingerprints and was diagnosed, identically, on each.
 */
export class IncidentTriagePriorDiagnosis extends Schema.Class<IncidentTriagePriorDiagnosis>(
	"IncidentTriagePriorDiagnosis",
)({
	investigationId: InvestigationId,
	/** The report's headline, or its summary when an older report has none. */
	headline: Schema.String,
	exceptionType: Schema.NullOr(Schema.String),
}) {}

export class IncidentTriagePriorMatch extends Schema.Class<IncidentTriagePriorMatch>(
	"IncidentTriagePriorMatch",
)({
	investigationId: InvestigationId,
	/** The model's probability that this incident is that diagnosis firing again. */
	probability: TriageProbability,
}) {}

export class IncidentTriageVerdict extends Schema.Class<IncidentTriageVerdict>("IncidentTriageVerdict")({
	disposition: IncidentDisposition,
	/** The model's own probability for the disposition it chose. */
	dispositionConfidence: TriageProbability,
	/** Severity on the same four-value scale the rest of the product uses. */
	severity: IssueSeverity,
	severityConfidence: TriageProbability,
	/** How likely a customer noticed. Kept whole: a gate may want it later. */
	userImpact: TriageProbability,
	/**
	 * The prior diagnosis the model reads this incident as another flare-up of.
	 * Absent when none was offered; `null` when some were and none matched.
	 */
	matchedPrior: Schema.optionalKey(Schema.NullOr(IncidentTriagePriorMatch)),
	/** The model id that answered, so a verdict stays readable after a model change. */
	model: Schema.String,
}) {}

/** The request half: what the classifier is given to judge. */
export class IncidentTriageRequest extends Schema.Class<IncidentTriageRequest>("IncidentTriageRequest")({
	title: Schema.String,
	incidentKind: Schema.String,
	/** Why the incident opened, when the producer knows: `first_seen`, `regression`. */
	reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
	/** Recent diagnoses for the same service, newest first. See {@link PRIOR_DIAGNOSES_LIMIT}. */
	priorDiagnoses: Schema.optionalKey(Schema.Array(IncidentTriagePriorDiagnosis)),
}) {}

/**
 * The bearer a Worker presents to another Worker's internal endpoint:
 * `Authorization: Bearer maple_svc_<INTERNAL_SERVICE_TOKEN>`, the shape the chat
 * agent already uses against `/mcp`.
 */
export const INTERNAL_SERVICE_BEARER_PREFIX = "maple_svc_"
export const internalServiceBearer = (token: string): string =>
	`Bearer ${INTERNAL_SERVICE_BEARER_PREFIX}${token}`

export class IncidentTriageUnauthorizedError extends Schema.TaggedError<IncidentTriageUnauthorizedError>()(
	"@maple/http/errors/IncidentTriageUnauthorizedError",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

/** The decision model did not answer. The caller treats this as "no verdict", never as "skip". */
export class IncidentTriageModelError extends Schema.TaggedError<IncidentTriageModelError>()(
	"@maple/http/errors/IncidentTriageModelError",
	{ message: Schema.String },
	{ httpApiStatus: 502 },
) {}

/**
 * The classifier as maple-ai serves it to the Workers that open incidents.
 *
 * Its own group rather than a `/mcp` tool because the caller is a cron tick
 * with no tenant of its own: the internal service token is the whole identity,
 * and the endpoint never reads or writes anything of the org's.
 */
export class IncidentTriageApiGroup extends HttpApiGroup.make("triage")
	.add(
		HttpApiEndpoint.post("classify", "/classify", {
			headers: Schema.Struct({ authorization: Schema.String }),
			payload: IncidentTriageRequest,
			success: IncidentTriageVerdict,
			error: [IncidentTriageUnauthorizedError, IncidentTriageModelError],
		}),
	)
	.prefix("/internal/triage") {}
