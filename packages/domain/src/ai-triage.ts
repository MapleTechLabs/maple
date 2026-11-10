// Stored shapes shared by the HTTP contract (`./http/ai-triage.ts`) and the Postgres tables.

import { IssueSeverity } from "./error-issues"
import { RepoFullName } from "./vcs"
import { Schema } from "effect"

/** A short or full lowercase git sha, as the agent saw it. */
export const SUSPECT_SHA = /^[0-9a-f]{7,40}$/u

export const AiTriageIncidentKind = Schema.Literals(["error", "anomaly", "alert"]).annotate({
	identifier: "@maple/AiTriageIncidentKind",
	title: "AI Triage Incident Kind",
})
export type AiTriageIncidentKind = Schema.Schema.Type<typeof AiTriageIncidentKind>

export class AiTriageEvidence extends Schema.Class<AiTriageEvidence>("AiTriageEvidence")({
	traceIds: Schema.Array(Schema.String),
	logPatterns: Schema.Array(Schema.String),
	relatedServices: Schema.Array(Schema.String),
	note: Schema.String,
}) {}

/**
 * The commit the agent holds responsible, when the cause is a change it could pin to one: what the
 * dashboard's "Fix in Claude Code" opens the repository at. `repo` is `owner/name` when known.
 */
export const AiTriageSuspectCommit = Schema.Struct({
	sha: Schema.String.check(Schema.isPattern(SUSPECT_SHA)),
	repo: Schema.optionalKey(RepoFullName),
})
export type AiTriageSuspectCommit = Schema.Schema.Type<typeof AiTriageSuspectCommit>

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
	/** `optionalKey`: most causes are not one commit, and older reports never carry it. */
	suspectCommit: Schema.optionalKey(AiTriageSuspectCommit),
}) {}
