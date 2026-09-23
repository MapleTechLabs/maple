import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Effect, Schema } from "effect"
import { ChatProposalDecision } from "../chat-session"
import { SessionAuthorization } from "./current-tenant"

/**
 * Decide an approval-gated AI chat proposal as the signed-in user.
 *
 * The agent's turn *stops* on a mutating tool and records a `tool-call` with `proposed: true` and
 * no result. This endpoint settles it by reference, through the same `ChatSession.settleProposal`
 * a chat-platform approval takes: the session reads the tool and its arguments out of its own
 * log, and records the outcome as that call's `tool-result` — which resolves the card on every
 * device and tells the model's next turn what happened.
 *
 * Anything else a client sends is ignored, including the `tool`/`input`/`messageId` of a tab
 * loaded before the request went by reference.
 */
export class ChatApplyRequest extends Schema.Class<ChatApplyRequest>("ChatApplyRequest")({
	/** The conversation the proposal came from; it has to be the caller's org. */
	sessionId: Schema.String,
	/** The proposed call's id. */
	toolCallId: Schema.String,
	/** Absent from a tab loaded before denials were recorded, which only ever approved. */
	decision: ChatProposalDecision.pipe(Schema.withDecodingDefaultKey(Effect.succeed("approve" as const))),
}) {}

export class ChatApplyResponse extends Schema.Class<ChatApplyResponse>("ChatApplyResponse")({
	/** What the conversation recorded as the call's result. */
	content: Schema.String,
	/** True when the proposal was declined, or the tool ran and reported a domain-level error. */
	isError: Schema.optionalKey(Schema.Boolean),
}) {}

/** The conversation is not the caller's, or holds no proposal with this id. */
export class ChatToolNotFoundError extends Schema.TaggedError<ChatToolNotFoundError>()(
	"@maple/http/errors/ChatToolNotFoundError",
	{
		toolCallId: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

/** Somebody already decided this proposal. */
export class ChatToolNotApplicableError extends Schema.TaggedError<ChatToolNotApplicableError>()(
	"@maple/http/errors/ChatToolNotApplicableError",
	{
		toolCallId: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

/** The session could not be reached, or did not answer; the tool may still have run. */
export class ChatToolExecutionError extends Schema.TaggedError<ChatToolExecutionError>()(
	"@maple/http/errors/ChatToolExecutionError",
	{
		toolCallId: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

export class ChatApiGroup extends HttpApiGroup.make("chat")
	.add(
		HttpApiEndpoint.post("apply", "/apply", {
			payload: ChatApplyRequest,
			success: ChatApplyResponse,
			error: [ChatToolNotFoundError, ChatToolNotApplicableError, ChatToolExecutionError],
		}),
	)
	.prefix("/internal/chat")
	.middleware(SessionAuthorization) {}
