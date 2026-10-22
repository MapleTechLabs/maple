import { ChatApplyRequest } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MapleAiClient } from "../../../platform/api-clients"
import { writeClipboardFallback } from "@maple/ui/lib/clipboard"
import { highlight } from "../kit/code-highlight"
import { parseMarkdownTexts } from "../../kit/markdown"
import { renderMermaid } from "../kit/mermaid"
import { abortTurn, loadHistory, postMessage } from "../kit/chat-api"
import { historyMessageToUIMessage } from "../kit/fold"
import { trackProduct } from "../../../data/analytics"
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
		raw: Schema.String,
	},
	messages: [Message.CompletedPostMessage],
	execute: ({ sessionId, generation, localId, text, raw }) =>
		postMessage(sessionId, text).pipe(
			Effect.map((sent) => ({ cursor: sent.cursor, messageId: sent.messageId })),
			Effect.mapError(errorText),
			Effect.result,
			Effect.map((result) => Message.CompletedPostMessage({ generation, localId, raw, result })),
		),
})

/** `chat_message_sent`: whether it opened the conversation; the text stays out of the event. */
export const TrackMessageSent = Command.define("TrackChatMessageSent", {
	args: { turn: Schema.Literals(["first", "followup"]) },
	messages: [Message.CompletedTrackMessageSent],
	execute: ({ turn }) =>
		trackProduct("chat_message_sent", { turn }).pipe(Effect.as(Message.CompletedTrackMessageSent())),
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

/** One fence coloured by Shiki (loaded on first use); a failure leaves it plain. */
export const HighlightCode = Command.define("HighlightChatCode", {
	args: { key: Schema.String, language: Schema.String, code: Schema.String },
	messages: [Message.CompletedHighlightCode],
	execute: ({ key, language, code }) =>
		highlight(language, code).pipe(
			Effect.map((highlighted) => Message.CompletedHighlightCode({ key, highlighted })),
			Effect.orElseSucceed(() => Message.CompletedHighlightCode({ key, highlighted: null })),
		),
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

const saveFile = (name: string, contents: string | Blob, type: string) =>
	Effect.sync(() => {
		const url = URL.createObjectURL(
			typeof contents === "string" ? new Blob([contents], { type }) : contents,
		)
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
	execute: ({ code }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(code)).pipe(
			Effect.catch(() => Effect.try(() => writeClipboardFallback(code))),
			Effect.ignore,
			Effect.as(Message.CompletedCodeAction()),
		),
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

/** `nn`: the `<svg>` element of mermaid's markup, serialized as XML. */
const svgDocument = (markup: string): string => {
	const svg = new DOMParser().parseFromString(markup, "text/html").querySelector("svg")
	return svg === null ? markup : new XMLSerializer().serializeToString(svg)
}

/** `rn`: the SVG drawn on a canvas at 5x and encoded as PNG. */
const svgToPng = (svg: string) =>
	Effect.callback<Blob, "unencodable">((resume) => {
		const image = new Image()
		image.crossOrigin = "anonymous"
		image.onload = () => {
			const canvas = document.createElement("canvas")
			canvas.width = image.width * 5
			canvas.height = image.height * 5
			canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height)
			canvas.toBlob(
				(blob) => resume(blob === null ? Effect.fail("unencodable") : Effect.succeed(blob)),
				"image/png",
			)
		}
		image.onerror = () => resume(Effect.fail("unencodable"))
		image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
	})

/** The download menu's formats (`ct`): the source as `.mmd`, or the rendered diagram as SVG or PNG. */
export const DownloadDiagram = Command.define("DownloadChatDiagram", {
	args: { menuId: Schema.String, code: Schema.String, format: Schema.Literals(["svg", "png", "mmd"]) },
	messages: [Message.CompletedDownloadDiagram],
	execute: ({ menuId, code, format }) =>
		(format === "mmd"
			? saveFile("diagram.mmd", code, "text/plain")
			: Effect.map(renderMermaid(code), svgDocument).pipe(
					Effect.flatMap((svg) =>
						format === "svg"
							? saveFile("diagram.svg", svg, "image/svg+xml")
							: Effect.flatMap(svgToPng(svg), (png) =>
									saveFile("diagram.png", png, "image/png"),
								),
					),
				)
		).pipe(
			Effect.as(true),
			Effect.orElseSucceed(() => false),
			Effect.map((isSaved) => Message.CompletedDownloadDiagram({ menuId, isSaved })),
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
