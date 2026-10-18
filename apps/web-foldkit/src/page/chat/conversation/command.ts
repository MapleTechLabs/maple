import { ChatApplyRequest } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MapleAiClient } from "../../../platform/api-clients"
import { parseChatMarkdown } from "../kit/markdown-parse"
import { abortTurn, loadHistory, postMessage } from "../kit/chat-api"
import { historyMessageToUIMessage } from "../kit/fold"
import { Message } from "./message"

const errorText = (error: { readonly message: string }): string => error.message

export const LoadHistory = Command.define("LoadChatHistory", {
	args: { sessionId: Schema.String, generation: Schema.Number },
	messages: [Message.CompletedLoadHistory],
	execute: ({ sessionId, generation }) =>
		loadHistory(sessionId).pipe(
			Effect.map((history) => ({
				messages: history.messages.map(historyMessageToUIMessage),
				cursor: history.cursor,
				running: history.running,
			})),
			Effect.mapError(errorText),
			Effect.result,
			Effect.map((result) => Message.CompletedLoadHistory({ generation, result })),
		),
})

export const PostMessage = Command.define("PostChatMessage", {
	args: { sessionId: Schema.String, generation: Schema.Number, localId: Schema.String, text: Schema.String, raw: Schema.String },
	messages: [Message.CompletedPostMessage],
	execute: ({ sessionId, generation, localId, text, raw }) =>
		postMessage(sessionId, text).pipe(
			Effect.map((sent) => ({ cursor: sent.cursor, messageId: sent.messageId })),
			Effect.mapError(errorText),
			Effect.result,
			Effect.map((result) => Message.CompletedPostMessage({ generation, localId, raw, result })),
		),
})

export const AbortTurn = Command.define("AbortChatTurn", {
	args: { sessionId: Schema.String },
	messages: [Message.CompletedAbortTurn],
	execute: ({ sessionId }) => Effect.as(abortTurn(sessionId), Message.CompletedAbortTurn()),
})

export const ParseMarkdown = Command.define("ParseChatMarkdown", {
	args: { texts: Schema.Array(Schema.String) },
	messages: [Message.CompletedParseMarkdown],
	execute: ({ texts }) =>
		Effect.map(parseChatMarkdown(texts), (parsed) => Message.CompletedParseMarkdown({ parsed })),
})

/** `MapleAiAtomClient.mutation("chat", "apply")`: the session runs (or declines) the proposal. */
export const DecideApproval = Command.define("DecideChatApproval", {
	args: {
		sessionId: Schema.String,
		toolCallId: Schema.String,
		tool: Schema.String,
		decision: Schema.Literals(["approve", "deny"]),
	},
	messages: [Message.CompletedDecideApproval],
	execute: ({ sessionId, toolCallId, tool, decision }) =>
		Effect.gen(function* () {
			const client = yield* MapleAiClient
			const response = yield* client.chat.apply({
				payload: new ChatApplyRequest({ sessionId, toolCallId, decision }),
			})
			return { isError: response.isError === true, content: response.content }
		}).pipe(
			Effect.mapError((error) => ("message" in error && typeof error.message === "string" ? error.message : "Request failed")),
			Effect.result,
			Effect.map((result) => Message.CompletedDecideApproval({ toolCallId, tool, decision, result })),
		),
})
