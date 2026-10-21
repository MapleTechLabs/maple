/**
 * The model's read of a plan cancellation, next to the rules' one.
 *
 * The rules in `@maple/backend` decide a reason from usage numbers alone. This
 * reads what they cannot: what the customer wrote on Stripe, what their
 * sessions in the app show, and what the audit log says they changed. It is one
 * structured call with no tools, so it either answers in a few seconds or the
 * report goes out without it.
 */
import { CancellationModelRead, CancellationModelRequest, CancellationModelVerdict } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { LanguageModel, Prompt } from "effect/ai"

export const CANCELLATION_READER_SYSTEM_PROMPT = `You review why a customer cancelled their plan on Maple, an observability platform (traces, logs, metrics, dashboards, alerts).

Fixed rules already picked a reason from usage numbers. The possible rule reasons:
- never_activated: barely or never sent telemetry
- stopped_sending: telemetry stopped or wound down
- not_engaged: telemetry flowed but nobody opened the app
- cost: an invoice jumped or usage went past the plan's allowance
- payment_failure: the plan ended on a failed payment
- unclear: usage looked healthy, so the numbers do not say

You also get evidence the rules cannot read:
- stripeFeedback: what the customer chose and wrote when cancelling. The strongest evidence when present.
- sessions: their browser sessions in Maple's app (pages visited, errors they hit), newest first.
- auditLog: actions taken in their org (keys, integrations, dashboards, members), newest first.

Answer with one verdict:
- "agree": the rules' reason fits and the evidence adds nothing a reader would act on. reason and note are null.
- "override": the evidence clearly points to a different reason, such as the customer saying so on Stripe, or sessions showing them stuck on one feature. reason is that reason in at most six words; note says why, citing the evidence.
- "context": the rules' reason stands (or nothing contradicts it) but the evidence adds something specific a person following up should know. reason is null; note says it.

Rules for the note: one to three short sentences, plain text, no markdown. Cite concrete evidence (a page path, an error message, an audit action, the customer's words). Never restate the usage numbers the rules already show. Do not speculate past the evidence. Prefer "agree" over a vague note: if you cannot point to a specific item, say nothing.`

/** What the model fills in; the model id is added by the caller. */
const Answer = Schema.Struct({
	verdict: CancellationModelVerdict,
	reason: Schema.NullOr(Schema.String),
	note: Schema.NullOr(Schema.String),
})

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(CancellationModelRequest))

/**
 * The model's answer, cleaned of the contradictions a schema cannot rule out:
 * an `agree` that still wrote a note, or an `override` without a reason.
 */
export const normalizeAnswer = (answer: typeof Answer.Type, model: string): CancellationModelRead => {
	const note = answer.note?.trim() || null
	const reason = answer.reason?.trim() || null
	if (answer.verdict === "override" && reason !== null) {
		return new CancellationModelRead({ verdict: "override", reason, note, model })
	}
	if (answer.verdict !== "agree" && note !== null) {
		return new CancellationModelRead({ verdict: "context", reason: null, note, model })
	}
	return new CancellationModelRead({ verdict: "agree", reason: null, note: null, model })
}

export const readCancellation = (request: CancellationModelRequest, model: string) =>
	LanguageModel.generateObject({
		prompt: Prompt.make([
			{ role: "system", content: CANCELLATION_READER_SYSTEM_PROMPT },
			{ role: "user", content: encodeRequest(request) },
		]),
		schema: Answer,
		objectName: "cancellation_read",
	}).pipe(
		Effect.map((response) => normalizeAnswer(response.value, model)),
		Effect.withSpan("CancellationReader.read", {
			attributes: { "maple.cancellation.rule_reason": request.ruleReason },
		}),
	)
