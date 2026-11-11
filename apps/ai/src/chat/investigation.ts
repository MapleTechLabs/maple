/** `submit_diagnosis`: how an investigation's turn files its report. */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import {
	AiTriageSubmission,
	type InvestigationDataCorruptionError,
	type InvestigationNotFoundError,
	type InvestigationPersistenceError,
	normalizeTriageSubmission,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { Array as Arr, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { MapleToolFailure, summarizeToolFailure } from "../mcp/tools/llm-tools"
import { toolHandlersWithContent } from "../platform/genai-spans"
import { type CompletionRun, type RunCompletion, SUBMIT_DIAGNOSIS } from "./completion"

/** Files the investigation's report; the caller has already bound the org and the investigation. */
export type SubmitDiagnosis = (
	request: SubmitDiagnosisRequest,
) => Effect.Effect<
	unknown,
	InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
>

/**
 * `parameters` is the lenient {@link AiTriageSubmission}, not the stored `AiTriageResult`.
 *
 * The engine decodes a tool call's arguments before the handler runs, and a decode failure lands in
 * the model stream's error channel, which ends the run. Against a strict report schema that made
 * one missing key at the end of a full investigation throw the whole investigation away. The
 * handler normalizes instead, and records what the model left out.
 *
 * `failureMode: "return"` is what makes a call the schema still rejects a recoverable tool error:
 * the engine defers validation for such tools instead of failing the model stream.
 */
export const diagnosisTool = Tool.make(SUBMIT_DIAGNOSIS, {
	description:
		"Record your structured diagnosis for THIS investigation. Call it exactly once, " +
		"after you have gathered evidence, with your final assessment. `evidence` is an array of " +
		"objects ({traceIds, logPatterns, relatedServices, note}); `suggestedActions`, `ruledOut` " +
		"and `unchecked` are arrays of strings; `suspectCommit` ({sha, repo}) only when one observed " +
		"commit caused it. It persists the report and renders it for the user. " +
		"After calling it, stop unless the user asks a follow-up.",
	parameters: AiTriageSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	failureMode: "return",
})

/**
 * The `submit_diagnosis` tool for an investigation session (`"<orgId>:inv-<id>"`).
 *
 * Its arguments ARE the structured report. Deliberately not approval-gated: it is the structured
 * output channel, not a user-facing mutation. The caller binds the investigation and org from the
 * session id, so the agent never chooses which investigation it writes. Being outside the ruleset
 * is why the origin is consulted here directly rather than left to the gate.
 *
 * `submitDiagnosis` arrives as a callback rather than being resolved from `InvestigationService`
 * here: that service is itself what starts an investigation's autonomous run, so resolving it
 * through the requirements channel would make it require itself.
 *
 * `submitted` reports whether the tool landed a report during the run. The engine is never told
 * the tool is *required*: a required completion becomes `tool_choice: required` on every model
 * call, which the providers Maple runs on do not reliably honour, and the engine fails the whole
 * run when they do not. The turn runner checks `submitted` instead and closes the pass itself.
 */
export const diagnosisCompletion = (origin: ChatTurnOrigin, submitDiagnosis: SubmitDiagnosis) => {
	// A connector never files a diagnosis. This tool rides *outside* the ruleset — it is the
	// investigation's structured output channel, not a gated mutation — so nothing else withholds
	// it, and it does write: a report row, and the investigation's status. An attended follow-up in
	// the app may file one; a channel is not where a diagnosis gets settled.
	if (origin.kind === "connector") return undefined
	return (run: CompletionRun) => buildDiagnosisCompletion(run, submitDiagnosis)
}

const buildDiagnosisCompletion = (
	{ turnId, usage, modelName, partial, sessionAttributes }: CompletionRun,
	submitDiagnosis: SubmitDiagnosis,
) => {
	const toolkit = Toolkit.make(diagnosisTool)
	let submitted = false
	return {
		tool: SUBMIT_DIAGNOSIS,
		toolkit,
		...toolHandlersWithContent(
			toolkit,
			{
				[SUBMIT_DIAGNOSIS]: (submission: AiTriageSubmission) =>
					Effect.suspend(() => {
						const { report, filled } = normalizeTriageSubmission(submission)
						return submitDiagnosis(
							new SubmitDiagnosisRequest({
								report,
								model: modelName,
								inputTokens: usage.input,
								outputTokens: usage.output,
								...(partial ? { partial: true } : undefined),
								turnId,
							}),
						).pipe(
							Effect.tap(() =>
								// What the model omitted is the signal that the prompt or the model is the
								// problem; without it a filled-in report is indistinguishable from a written one.
								Effect.annotateCurrentSpan({
									"maple.diagnosis.filled_fields": Arr.join(filled, ","),
									"maple.diagnosis.filled_count": filled.length,
								}),
							),
						)
					}).pipe(
						Effect.tap(() => Effect.sync(() => (submitted = true))),
						Effect.as("Diagnosis recorded."),
						// Named failures only. A rendered Effect cause carries stack frames and, inside a
						// DatabaseError, connection details.
						Effect.catchCause((cause) =>
							Effect.fail(
								new MapleToolFailure({
									message: `${SUBMIT_DIAGNOSIS} failed: ${summarizeToolFailure(cause)}`,
								}),
							),
						),
					),
			},
			sessionAttributes,
		),
		submitted: () => submitted,
	} satisfies RunCompletion
}
