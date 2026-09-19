import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { IsoDateTimeString, UserId } from "../primitives"
import { SessionAuthorization } from "./current-tenant"
import { IssueSeverity } from "./errors"

// Literals

export const AiTriageIncidentKind = Schema.Literals(["error", "anomaly", "alert"]).annotate({
	identifier: "@maple/AiTriageIncidentKind",
	title: "AI Triage Incident Kind",
})
export type AiTriageIncidentKind = Schema.Schema.Type<typeof AiTriageIncidentKind>

// Structured triage result (what the agent must submit)

export class AiTriageEvidence extends Schema.Class<AiTriageEvidence>("AiTriageEvidence")({
	traceIds: Schema.Array(Schema.String),
	logPatterns: Schema.Array(Schema.String),
	relatedServices: Schema.Array(Schema.String),
	note: Schema.String,
}) {}

export class AiTriageResult extends Schema.Class<AiTriageResult>("AiTriageResult")({
	/**
	 * One line naming the cause, for the hub row, the verdict heading and the graph node; `summary`
	 * and `suspectedCause` are both prompted as prose. `optionalKey` so older reports decode, and
	 * unenforced at the tool boundary for the reason on `ruledOut`. Readers fall back to `summary`.
	 */
	headline: Schema.optionalKey(Schema.String),
	summary: Schema.String,
	suspectedCause: Schema.String,
	/**
	 * Shares the canonical IssueSeverity literal so the agent's assessment can be
	 * applied to issues verbatim without a mapping layer.
	 *
	 * `optionalKey` for the *partial* — a validator that promoted nothing has no
	 * cause whose severity it could assess, and the four literals give it nothing
	 * honest to send. Required, it forced a fabricated severity onto every "we
	 * could not tell", and the submissions that instead sent `"unclassified"`
	 * were rejected at the tool boundary at the end of a spent investigation
	 * budget — losing the whole run to a field that path throws away
	 * (`applyInconclusiveWrites` writes `severity: null` regardless).
	 *
	 * Widening {@link IssueSeverity} itself was the alternative and is worse: that
	 * literal is the issues system's severity, read by the severity sort rank, the
	 * escalation policy, the list cursor, the facets and the DB enum, none of
	 * which would ever see the new member from anywhere but here.
	 *
	 * Absent on a *promoted* report is a defective submission rather than a
	 * signal, and is handled the same way for the same reason: `applyTriageSeverity`
	 * declines to re-rank a linked issue on a judgement the model did not make.
	 */
	severityAssessment: Schema.optionalKey(IssueSeverity),
	affectedScope: Schema.String,
	evidence: Schema.Array(AiTriageEvidence),
	suggestedActions: Schema.Array(Schema.String),
	confidence: Schema.Literals(["high", "medium", "low"]),
	/**
	 * Causes that were checked and eliminated, each with the evidence that
	 * eliminated it — "Deploy: service.version unchanged across 41k spans in the
	 * window".
	 *
	 * This is what makes a report believable in either direction. A named cause is
	 * only as credible as what else was considered, and an "unknown" that lists
	 * nothing is indistinguishable from not having investigated at all — which is
	 * precisely how a diagnosis of "it's an unknown error" used to be a compliant
	 * answer.
	 *
	 * `optionalKey` so every report already stored still decodes, and deliberately
	 * *not* enforced at the tool boundary: the prompts require it. A schema that
	 * rejects a submission teaches the model to satisfy the validator rather than
	 * to do the work, and a rejected submission at the end of a spent budget loses
	 * the whole investigation.
	 */
	ruledOut: Schema.optionalKey(Schema.Array(Schema.String)),
	/**
	 * Angles this run could NOT check, and why — "connection-pool depth:
	 * payments-api emits no `db.client.connections.*` instrument", "the 14:02
	 * rollout: the lane ran out of clock before it finished".
	 *
	 * The other half of what makes a report believable, and the half that only
	 * matters when nothing was promoted. {@link ruledOut} says what was
	 * eliminated; without this, everything that was neither eliminated nor
	 * promoted is silently indistinguishable from something nobody thought of —
	 * and a responder reading a partial cannot tell which of the two they are
	 * looking at.
	 *
	 * `optionalKey` and unenforced at the tool boundary, for the same two reasons
	 * as {@link ruledOut} directly above.
	 */
	unchecked: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/**
 * What `submit_diagnosis` accepts off the wire, as opposed to what a stored report is.
 *
 * Every field is optional here, and that is the whole point. {@link AiTriageResult} is the shape a
 * *reader* can rely on; this is the shape a language model actually produces at the end of a spent
 * budget. When a required key was missing the engine's tool-parameter decode failed inside the
 * model stream's error channel, which ends the run, so an investigation that had done all its work
 * and written most of a report was thrown away over one absent array. Prod, 2026-09-19: seven of
 * fifteen finished turns died on `Missing key at ["params"]["suggestedActions"]`,
 * `["suspectedCause"]`, `["summary"]` and `["evidence"][0]["logPatterns"]`.
 *
 * `headline`, `ruledOut`, `unchecked` and `severityAssessment` were already made optional for
 * exactly this reason, one field at a time, as each one was caught losing runs. Carrying it through
 * to the rest stops the next field from having its own incident.
 *
 * The prompt is what asks for these fields, not the schema. A schema that rejects a submission
 * teaches the model to satisfy the validator; it does not teach it to investigate. What the model
 * omitted is recorded on the span by {@link normalizeTriageSubmission} instead, so the omissions
 * stay measurable rather than fatal.
 */
export const AiTriageEvidenceSubmission = Schema.Struct({
	traceIds: Schema.optionalKey(Schema.Array(Schema.String)),
	logPatterns: Schema.optionalKey(Schema.Array(Schema.String)),
	relatedServices: Schema.optionalKey(Schema.Array(Schema.String)),
	note: Schema.optionalKey(Schema.String),
})

export const AiTriageSubmission = Schema.Struct({
	headline: Schema.optionalKey(Schema.String),
	summary: Schema.optionalKey(Schema.String),
	suspectedCause: Schema.optionalKey(Schema.String),
	/**
	 * Unknown severity literals are dropped rather than rejected. A model that answers
	 * `"unclassified"` has told us it could not rank the incident, which is information; failing the
	 * submission over it discards the rest of the report as well.
	 */
	severityAssessment: Schema.optionalKey(Schema.Union([IssueSeverity, Schema.String])),
	affectedScope: Schema.optionalKey(Schema.String),
	evidence: Schema.optionalKey(Schema.Array(AiTriageEvidenceSubmission)),
	suggestedActions: Schema.optionalKey(Schema.Array(Schema.String)),
	confidence: Schema.optionalKey(Schema.Union([Schema.Literals(["high", "medium", "low"]), Schema.String])),
	ruledOut: Schema.optionalKey(Schema.Array(Schema.String)),
	unchecked: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type AiTriageSubmission = Schema.Schema.Type<typeof AiTriageSubmission>

const TRIAGE_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"])
const TRIAGE_CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"])

/** Stand-in prose when the model filed a report without the field a reader needs. */
const MISSING_PROSE = "The agent did not record this."

/**
 * A wire submission as a storable report, plus the list of fields it did not supply.
 *
 * The filled list is not cosmetic: a report where `suspectedCause` was invented by this function
 * reads exactly like one the agent wrote, and only the count of omissions says which prompt or
 * which model is failing. It goes on the span as `maple.diagnosis.filled_fields`.
 *
 * `confidence` defaults to `low` rather than `medium` because a submission that omitted fields is,
 * by that fact alone, not a confident one.
 */
export const normalizeTriageSubmission = (
	submission: AiTriageSubmission,
): { readonly report: AiTriageResult; readonly filled: ReadonlyArray<string> } => {
	const filled: Array<string> = []
	const text = (value: string | undefined, field: string): string => {
		const trimmed = value?.trim()
		if (trimmed !== undefined && trimmed.length > 0) return trimmed
		filled.push(field)
		return MISSING_PROSE
	}
	const list = (value: ReadonlyArray<string> | undefined, field: string): ReadonlyArray<string> => {
		if (value !== undefined && value.length > 0) return value
		filled.push(field)
		return []
	}

	const severity =
		submission.severityAssessment !== undefined && TRIAGE_SEVERITIES.has(submission.severityAssessment)
			? (submission.severityAssessment as IssueSeverity)
			: undefined
	if (submission.severityAssessment !== undefined && severity === undefined)
		filled.push("severityAssessment")

	const confidence =
		submission.confidence !== undefined && TRIAGE_CONFIDENCES.has(submission.confidence)
			? (submission.confidence as "high" | "medium" | "low")
			: (filled.push("confidence"), "low" as const)

	const evidence = (submission.evidence ?? []).map((entry) => ({
		traceIds: entry.traceIds ?? [],
		logPatterns: entry.logPatterns ?? [],
		relatedServices: entry.relatedServices ?? [],
		note: entry.note ?? "",
	}))
	if (submission.evidence === undefined) filled.push("evidence")

	const summary = text(submission.summary, "summary")
	const report = new AiTriageResult({
		...(submission.headline === undefined ? undefined : { headline: submission.headline }),
		summary,
		suspectedCause: text(submission.suspectedCause, "suspectedCause"),
		...(severity === undefined ? undefined : { severityAssessment: severity }),
		affectedScope: text(submission.affectedScope, "affectedScope"),
		evidence,
		suggestedActions: list(submission.suggestedActions, "suggestedActions"),
		confidence,
		...(submission.ruledOut === undefined ? undefined : { ruledOut: submission.ruledOut }),
		...(submission.unchecked === undefined ? undefined : { unchecked: submission.unchecked }),
	})
	return { report, filled }
}

/**
 * What today's budget has actually been spent on, in both units.
 *
 * Ships with the settings rather than as its own endpoint because a ceiling and
 * its consumption are unreadable apart: "1000 passes/day" answers nothing on its
 * own, and the question an operator arrives with is always whether triage is
 * running right now.
 */
export class AiTriageUsage extends Schema.Class<AiTriageUsage>("AiTriageUsage")({
	runs: Schema.Number,
	passes: Schema.Number,
}) {}

export class AiTriageSettingsDocument extends Schema.Class<AiTriageSettingsDocument>(
	"AiTriageSettingsDocument",
)({
	enabled: Schema.Boolean,
	maxRunsPerDay: Schema.Number,
	/** Model passes per day — one investigation spends `fanoutSize + 1`, so 4–7. */
	maxPassesPerDay: Schema.Number,
	/** Spent so far in the current UTC day. */
	usage: AiTriageUsage,
	/**
	 * Whether an ordinary-severity incident would be refused right now.
	 *
	 * Derived server-side from the same verdict the enqueue path uses, at the same
	 * cost a real start reserves, so the banner cannot drift from the rule that
	 * actually refuses starts.
	 */
	ordinaryPaused: Schema.Boolean,
	/**
	 * Whether a `critical` would be refused too.
	 *
	 * Separate from {@link ordinaryPaused} because the two are different outages
	 * and the honest sentence differs: with only the ordinary slice gone, urgent
	 * incidents are still being investigated from the reserve; with this set,
	 * nothing is starting at all. Collapsing them tells an operator that criticals
	 * are covered at exactly the moment they are not.
	 */
	priorityPaused: Schema.Boolean,
	/**
	 * Which ceiling refused the start, so the copy can name the right number.
	 *
	 * The `*_reserved` members mean the budget is intact and this start was not
	 * important enough for what is left; the bare ones mean the org is out. They
	 * call for opposite responses, which is why this cannot be inferred from the
	 * two booleans alone.
	 */
	pausedDimension: Schema.NullOr(Schema.Literals(["runs", "runs_reserved", "passes", "passes_reserved"])),
	/** When the budget resets — the next UTC midnight. Null when nothing is paused. */
	resumesAt: Schema.NullOr(IsoDateTimeString),
	updatedAt: Schema.NullOr(IsoDateTimeString),
	updatedBy: Schema.NullOr(UserId),
}) {}

export class AiTriageSettingsUpdateRequest extends Schema.Class<AiTriageSettingsUpdateRequest>(
	"AiTriageSettingsUpdateRequest",
)({
	enabled: Schema.optionalKey(Schema.Boolean),
	maxRunsPerDay: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
	),
	maxPassesPerDay: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2000 })),
	),
}) {}

// Errors

export class AiTriagePersistenceError extends Schema.TaggedError<AiTriagePersistenceError>()(
	"@maple/http/ai-triage/AiTriagePersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class AiTriageForbiddenError extends Schema.TaggedError<AiTriageForbiddenError>()(
	"@maple/http/ai-triage/AiTriageForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class AiTriageValidationError extends Schema.TaggedError<AiTriageValidationError>()(
	"@maple/http/ai-triage/AiTriageValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

// API group

export class AiTriageApiGroup extends HttpApiGroup.make("aiTriage")
	.add(
		HttpApiEndpoint.get("getSettings", "/settings", {
			success: AiTriageSettingsDocument,
			error: AiTriagePersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("updateSettings", "/settings", {
			payload: AiTriageSettingsUpdateRequest,
			success: AiTriageSettingsDocument,
			error: [AiTriagePersistenceError, AiTriageForbiddenError, AiTriageValidationError],
		}),
	)
	.prefix("/internal/ai-triage")
	.middleware(SessionAuthorization) {}
