// What a failed span says, in one line a reader can act on.
//
// Frameworks bury the reason: a status message that only says the tool
// "reached a failed terminal state" while the tool's recorded result carries
// the real text, a message that leads with three namespaced error tags before
// the words, a schema failure spelled as a JSON path. Every reading of a
// failure on the page — the findings, the tool ledger, the MCP's session read —
// goes through here so they agree on the line.

import type { AiSessionSpan } from "@maple/domain/http"

import { classifyAiSpan } from "./session-turns"

/** Status messages a framework stamps on every failed tool call regardless of
 *  cause. They name nothing, so the recorded result is read instead. */
const GENERIC_TOOL_MESSAGE = /reached a failed terminal state|^tool (execution |call )?failed\.?$/i

/** Prefixes a message wears before the words that matter. Every leading tag
 *  goes: `@maple/mcp/errors/McpQueryError: @maple/http/errors/X: real text`. */
const LEADING_PREFIXES = [
	/^tool failed:\s*/i,
	/^model response failed:\s*/i,
	/^[a-z0-9_]+(?:\.[a-z0-9_]+)*\.streamtext:\s*/i,
	/^invalid output:\s*/i,
	/^invalid parameters:\s*/i,
]
const ERROR_TAG = /^@[\w-]+\/[\w./-]+:\s*/
const ERROR_ENVELOPE = /^\[error\]\s*/i

/** The path a schema failure ends in, once its whitespace is collapsed:
 *  ` at [2]["params"]["suggestedActions"]`. Each bracket group is consumed
 *  whole, so the match is linear in the text. */
const SCHEMA_PATH_MARKER = " at ["
const SCHEMA_PATH = /^(?:\[[^\]]*\])+/
const SCHEMA_PATH_KEY = /\["([^"]+)"\]/g

/** The framework's word for a run that ended without its required completion
 *  tool: `Model stopped without required completion Tool submit_plan`. */
const INCOMPLETE = /stopped without required completion tool\s+(\S+)/i

/** `Check the "sandbox_grep" tool schema` names the tool whose parameters
 *  failed, which the span's own tool name sometimes does not. */
const TOOL_SCHEMA_NAME = /"([\w.:-]+)" tool schema/

export function clipDetail(text: string): string {
	return text.length > 140 ? `${text.slice(0, 139)}…` : text
}

/**
 * Keys an error payload's human message hides under, tried before anything
 * else so a structured result yields its message rather than its first field.
 * `result` and `prefix` are Maple's own `toolCallJson` wrappers — a bare error
 * string is recorded as `{result}`, an over-budget one as `{truncated, prefix}`.
 */
const PROSE_KEYS = [
	"error",
	"message",
	"error_message",
	"errorMessage",
	"reason",
	"detail",
	"result",
	"prefix",
	"text",
]

/**
 * The human-readable text inside a captured payload. Maple's own tool errors
 * are plain strings; other vendors wrap the message in an object or an
 * MCP-style content array, so this walks tolerantly and gives up rather than
 * serialising structure into the row. The whole text, not its first line: a
 * schema failure puts the path on the line after the words
 * (`Missing key\n  at ["pattern"]`), and the first line alone would lose the
 * field it names.
 */
function wholeProse(value: unknown, depth = 0): string | undefined {
	if (depth > 4) return undefined
	if (typeof value === "string") {
		const text = value.trim()
		return text === "" ? undefined : text
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const prose = wholeProse(entry, depth + 1)
			if (prose !== undefined) return prose
		}
		return undefined
	}
	if (typeof value !== "object" || value === null) return undefined
	const record = value as Record<string, unknown>
	for (const key of PROSE_KEYS) {
		if (key in record) {
			const prose = wholeProse(record[key], depth + 1)
			if (prose !== undefined) return prose
		}
	}
	// `content` last and on its own: MCP results nest their text parts there.
	return "content" in record ? wholeProse(record.content, depth + 1) : undefined
}

/**
 * The raw text a failed span carries, wherever the framework put it: its
 * status message unless that is the framework's generic one, else the tool
 * call's recorded result. `undefined` when the span said nothing at all.
 */
export function rawFailureText(span: AiSessionSpan): string | undefined {
	return rawFailureTextOf({
		statusMessage: span.statusMessage,
		errorType: span.genAi.errorType,
		toolCallResult: span.genAi.toolCallResult,
	})
}

/** The three fields {@link rawFailureText} reads, as a span or an
 *  `ai_trace_index` row supplies them — the list classifies off the index. */
export interface FailureText {
	readonly statusMessage: string
	readonly errorType: string | undefined
	readonly toolCallResult: unknown
}

export function rawFailureTextOf(signal: FailureText): string | undefined {
	const message = signal.statusMessage.trim()
	const errorType = signal.errorType
	const informative = message !== "" && message !== errorType && !GENERIC_TOOL_MESSAGE.test(message)
	if (informative) return message
	const result = signal.toolCallResult
	const prose = result === undefined ? undefined : wholeProse(result)
	if (prose !== undefined) return prose
	return message === "" || message === errorType ? undefined : message
}

/** `SchemaError(` wraps its message in parentheses; the closing one, and the
 *  hint the framework appends after it, go with the opening one. */
const SCHEMA_ERROR_OPEN = /^schemaerror\(/i
const SCHEMA_ERROR_CLOSE = /\)(?:\.\s*Check the "[^"]+" tool schema[^\n]*)?$/i

/** The text with its framework prefixes and error-tag chain stripped. Every
 *  pass removes something or ends the loop, so it is bounded by the text. */
export function stripFailurePrefixes(text: string): string {
	let out = text.trim()
	let wrapped = false
	for (;;) {
		const before = out
		for (const prefix of LEADING_PREFIXES) out = out.replace(prefix, "")
		if (SCHEMA_ERROR_OPEN.test(out)) {
			out = out.replace(SCHEMA_ERROR_OPEN, "")
			wrapped = true
		}
		out = out.replace(ERROR_TAG, "").replace(ERROR_ENVELOPE, "")
		if (out === before) break
	}
	return wrapped ? out.replace(SCHEMA_ERROR_CLOSE, "").trim() : out
}

/**
 * A schema failure, humanised: `missing key \`suggestedActions\`` or
 * `\`incidentStartedAt\`: expected <filter>`. Only the last key of the path is
 * kept — the path's leading indices are the batch position, not the field.
 */
export function describeSchemaFailure(text: string): string | undefined {
	// Effect's `Schema` puts the path on its own line; one space between the
	// words and the marker is all the parse below needs.
	const message = stripFailurePrefixes(text).replace(/\s+/g, " ")
	const lower = message.toLowerCase()
	const kind = lower.startsWith("missing key")
		? "missing"
		: lower.startsWith("expected ")
			? "expected"
			: undefined
	if (kind === undefined) return undefined
	const marker = message.indexOf(SCHEMA_PATH_MARKER)
	if (marker === -1) return undefined
	const path = SCHEMA_PATH.exec(message.slice(marker + SCHEMA_PATH_MARKER.length - 1))?.[0]
	if (path === undefined) return undefined
	const keys = [...path.matchAll(SCHEMA_PATH_KEY)].flatMap((entry) =>
		entry[1] === undefined ? [] : [entry[1]],
	)
	const field = keys[keys.length - 1]
	if (field === undefined) return undefined
	if (kind === "missing") {
		return message.slice(0, marker).trim().toLowerCase() === "missing key"
			? `missing key \`${field}\``
			: undefined
	}
	const expected = message.slice("expected ".length, marker).trim()
	return expected === "" ? undefined : `\`${field}\`: expected ${expected}`
}

/** The completion tool a run ended without calling, when the message says. */
export function incompleteRunTool(text: string): string | undefined {
	let tool = INCOMPLETE.exec(text)?.[1]
	if (tool === undefined) return undefined
	while (tool.endsWith(".") || tool.endsWith(",") || tool.endsWith(";")) tool = tool.slice(0, -1)
	return tool === "" ? undefined : tool
}

/** The tool a parameter schema error names, when the message says. */
export function toolNamedBySchemaError(text: string): string | undefined {
	const match = TOOL_SCHEMA_NAME.exec(text)
	return match === null ? undefined : match[1]
}

/**
 * The one line the page shows for a failed span: what it said, made readable
 * and clipped. `undefined` when the span carries no text — the row then shows
 * its label alone, which is honest about what the instrumentation recorded.
 */
export function failureDetailText(span: AiSessionSpan): string | undefined {
	const raw = rawFailureText(span)
	if (raw === undefined) return undefined
	const schema = describeSchemaFailure(raw)
	if (schema !== undefined) {
		// On a tool span the schema is the tool's parameters and the model sent
		// them; anywhere else it is the output the agent demanded of the model.
		const isTool = span.genAi.toolName !== undefined || classifyAiSpan(span) === "tool"
		const subject = isTool ? "invalid arguments" : "output rejected by schema"
		return clipDetail(`${subject}: ${schema}`)
	}
	const incomplete = incompleteRunTool(raw)
	if (incomplete !== undefined) return clipDetail(`ended without calling \`${incomplete}\``)
	const stripped = stripFailurePrefixes(raw)
	return clipDetail(oneLine(stripped === "" ? raw : stripped))
}

/** A multi-line message on one line: the first line, as the ledger has always
 *  shown it, since what follows is a stack or a path the row cannot hold. */
function oneLine(text: string): string {
	const line = text
		.split("\n")
		.map((raw) => raw.trim())
		.find((raw) => raw.length > 0)
	return line ?? text
}
