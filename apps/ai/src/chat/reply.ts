/** `submit_reply` and `propose_edit`: how a pull request reply's turn answers, and stages a fix. */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import {
	PrReviewEditSubmission,
	type PrReviewPersistenceError,
	type PrReviewReplyNotFoundError,
	PrReviewReplySubmission,
} from "@maple/domain/http"
import { type Cause, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { MapleToolFailure, summarizeToolFailure } from "../mcp/tools/llm-tools"
import { toolHandlersWithContent } from "../platform/genai-spans"
import { type CompletionRun, type RunCompletion, SUBMIT_REPLY } from "./completion"

export const PROPOSE_EDIT = "propose_edit"

/** Posts the reply, and stages an edit for it; the caller has bound the org and the reply. */
export interface ReplyWrites {
	readonly submit: (
		body: string,
	) => Effect.Effect<string, PrReviewPersistenceError | PrReviewReplyNotFoundError>
	readonly stageEdit: (
		edit: PrReviewEditSubmission,
	) => Effect.Effect<string, PrReviewPersistenceError | PrReviewReplyNotFoundError>
}

export const replyTool = Tool.make(SUBMIT_REPLY, {
	description:
		"Post your answer on the pull request, in GitHub markdown, where the person asked. Call it " +
		"exactly once, after you have read what the answer depends on. For a fix, call it after " +
		"propose_edit: the staged edits are committed first and the result is added to your answer. " +
		"After calling it, stop.",
	parameters: PrReviewReplySubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	// See `diagnosisTool`: a rejected call is a result the model fixes, not a retried model call.
	failureMode: "return",
})

export const proposeEditTool = Tool.make(PROPOSE_EDIT, {
	description:
		"Stage one exact edit for a fix someone asked for with `@maple fix`. `oldText` is copied " +
		"verbatim from the file at the pull request's head and must occur there exactly once; it " +
		"becomes `newText`. An empty `oldText` creates a new file. Edits apply in order and are " +
		"committed together when you call submit_reply. The answer says whether it was staged.",
	parameters: PrReviewEditSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	failureMode: "return",
})

/**
 * `submit_reply` and `propose_edit` for a reply's unattended pass. The caller binds the reply, so
 * the agent never chooses which thread it answers or which branch it commits to.
 */
export const replyCompletion = (origin: ChatTurnOrigin, writes: ReplyWrites) => {
	if (origin.kind !== "autonomous") return undefined
	return (run: CompletionRun) => {
		const toolkit = Toolkit.make(replyTool, proposeEditTool)
		let submitted = false
		const asToolFailure = (tool: string) => (cause: Cause.Cause<unknown>) =>
			Effect.fail(new MapleToolFailure({ message: `${tool} failed: ${summarizeToolFailure(cause)}` }))
		return {
			tool: SUBMIT_REPLY,
			toolkit,
			...toolHandlersWithContent(
				toolkit,
				{
					[SUBMIT_REPLY]: (submission: PrReviewReplySubmission) =>
						writes.submit(submission.body ?? "").pipe(
							Effect.tap(() => Effect.sync(() => (submitted = true))),
							Effect.catchCause(asToolFailure(SUBMIT_REPLY)),
						),
					[PROPOSE_EDIT]: (edit: PrReviewEditSubmission) =>
						writes.stageEdit(edit).pipe(Effect.catchCause(asToolFailure(PROPOSE_EDIT))),
				},
				run.sessionAttributes,
			),
			submitted: () => submitted,
		} satisfies RunCompletion
	}
}
