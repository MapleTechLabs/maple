import { ChatApplyRequest } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MapleAiClient } from "../../../platform/api-clients"
import { writeClipboard } from "../../kit/clipboard"
import { parseMarkdownTexts } from "../../kit/markdown"
import { abortTurn, loadHistory, postMessage } from "./kit/chat-api"
import { historyMessageToUIMessage } from "./kit/fold"
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
	args: {
		sessionId: Schema.String,
		generation: Schema.Number,
		localId: Schema.String,
		text: Schema.String,
	},
	messages: [Message.CompletedPostMessage],
	execute: ({ sessionId, generation, localId, text }) =>
		postMessage(sessionId, text).pipe(
			Effect.map((sent) => ({ cursor: sent.cursor, messageId: sent.messageId })),
			Effect.mapError(errorText),
			Effect.result,
			Effect.map((result) => Message.CompletedPostMessage({ generation, localId, text, result })),
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
		Effect.map(parseMarkdownTexts(texts), (parsed) => Message.CompletedParseMarkdown({ parsed })),
})

/** Streamdown's file names: `file.<ext>` by the fence's language. */
const EXTENSIONS = new Map([
	["typescript", "ts"],
	["ts", "ts"],
	["javascript", "js"],
	["js", "js"],
	["python", "py"],
	["py", "py"],
	["bash", "sh"],
	["shell", "sh"],
	["sh", "sh"],
	["yaml", "yaml"],
	["yml", "yml"],
	["json", "json"],
	["sql", "sql"],
	["go", "go"],
	["rust", "rs"],
	["markdown", "md"],
])

const saveFile = (name: string, contents: string, type: string) =>
	Effect.sync(() => {
		const url = URL.createObjectURL(new Blob([contents], { type }))
		const anchor = document.createElement("a")
		anchor.href = url
		anchor.download = name
		document.body.appendChild(anchor)
		anchor.click()
		document.body.removeChild(anchor)
		URL.revokeObjectURL(url)
	})

export const CopyCode = Command.define("CopyChatCode", {
	args: { code: Schema.String },
	messages: [Message.CompletedCodeAction],
	execute: ({ code }) => Effect.as(writeClipboard(code), Message.CompletedCodeAction()),
})

export const DownloadCode = Command.define("DownloadChatCode", {
	args: { code: Schema.String, language: Schema.String },
	messages: [Message.CompletedCodeAction],
	execute: ({ code, language }) =>
		Effect.as(
			saveFile(`file.${EXTENSIONS.get(language.toLowerCase()) ?? "txt"}`, code, "text/plain"),
			Message.CompletedCodeAction(),
		),
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
			Effect.mapError((error) =>
				"message" in error && typeof error.message === "string" ? error.message : "Request failed",
			),
			Effect.result,
			Effect.map((result) => Message.CompletedDecideApproval({ toolCallId, tool, decision, result })),
		),
})
