// What a failed span says, in one line a reader can act on.
//
// Frameworks bury the reason: a status message that only says the tool
// "reached a failed terminal state" while the tool's recorded result carries
// the real text, a message that leads with three namespaced error tags before
// the words, a schema failure spelled as a JSON path. Every reading of a
// failure on the page — the findings, the tool ledger, the MCP's session read —
// goes through here so they agree on the line.

import type { AiSessionSpan } from "@maple/domain/http"

/** Status messages a framework stamps on every failed tool call regardless of
 *  cause. They name nothing, so the recorded result is read instead. */
const GENERIC_TOOL_MESSAGE = /reached a failed terminal state|^tool (execution |call )?failed\.?$/i

/** Prefixes a message wears before the words that matter. Every leading tag
 *  goes: `@maple/mcp/errors/McpQueryError: @maple/http/errors/X: real text`. */
const LEADING_PREFIXES = [
	/^tool failed:\s*/i,
	/^model response failed:\s*/i,
	/^[\w.]+\.streamtext:\s*/i,
	/^invalid output:\s*/i,
	/^invalid parameters:\s*/i,
	/^schemaerror\(/i,
]
const ERROR_TAG = /^@[\w-]+\/[\w./-]+:\s*/
const ERROR_ENVELOPE = /^\[error\]\s*/i

/** A schema failure as effect's `Schema` spells it: `Missing key\n  at
 *  [2]["params"]["suggestedActions"]` or `Expected <filter>\n  at [...]`. */
const SCHEMA_PATH = /^(missing key|expected\s+(.+?))\s+at\s+((?:\[[^\]]+\])+)/is

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
 * The first human-readable line inside a captured payload. Maple's own tool
 * errors are plain strings; other vendors wrap the message in an object or an
 * MCP-style content array, so this walks tolerantly and gives up rather than
 * serialising structure into the row.
 */
export function firstProse(value: unknown, depth = 0): string | undefined {
	return proseIn(value, depth, false)
}

/**
 * The whole text, not its first line: a schema failure puts the path on the
 * line after the words (`Missing key\n  at ["pattern"]`), and reading the
 * first line alone would lose the field it names.
 */
function wholeProse(value: unknown): string | undefined {
	return proseIn(value, 0, true)
}

function proseIn(value: unknown, depth: number, whole: boolean): string | undefined {
	if (depth > 4) return undefined
	if (typeof value === "string") {
		if (whole) {
			const text = value.trim()
			return text === "" ? undefined : text
		}
		return value
			.split("\n")
			.map((raw) => raw.trim())
			.find((raw) => raw.length > 0)
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const prose = proseIn(entry, depth + 1, whole)
			if (prose !== undefined) return prose
		}
		return undefined
	}
	if (typeof value !== "object" || value === null) return undefined
	const record = value as Record<string, unknown>
	for (const key of PROSE_KEYS) {
		if (key in record) {
			const prose = proseIn(record[key], depth + 1, whole)
			if (prose !== undefined) return prose
		}
	}
	// `content` last and on its own: MCP results nest their text parts there.
	return "content" in record ? proseIn(record.content, depth + 1, whole) : undefined
}

/**
 * The raw text a failed span carries, wherever the framework put it: its
 * status message unless that is the framework's generic one, else the tool
 * call's recorded result. `undefined` when the span said nothing at all.
 */
export function rawFailureText(span: AiSessionSpan): string | undefined {
	const message = span.statusMessage.trim()
	const errorType = span.genAi.errorType
	const informative = message !== "" && message !== errorType && !GENERIC_TOOL_MESSAGE.test(message)
	if (informative) return message
	const result = span.genAi.toolCallResult
	const prose = result === undefined ? undefined : wholeProse(result)
	if (prose !== undefined) return prose
	return message === "" || message === errorType ? undefined : message
}

/** The text with its framework prefixes and error-tag chain stripped. */
export function stripFailurePrefixes(text: string): string {
	let out = text.trim()
	for (let guard = 0; guard < 8; guard++) {
		const before = out
		for (const prefix of LEADING_PREFIXES) out = out.replace(prefix, "")
		out = out.replace(ERROR_TAG, "").replace(ERROR_ENVELOPE, "")
		if (out === before) break
	}
	return out
}

/**
 * A schema failure, humanised: `missing key \`suggestedActions\`` or
 * `\`incidentStartedAt\`: expected <filter>`. Only the last key of the path is
 * kept — the path's leading indices are the batch position, not the field.
 */
export function describeSchemaFailure(text: string): string | undefined {
	const match = SCHEMA_PATH.exec(stripFailurePrefixes(text))
	const path = match?.[3]
	if (match === null || path === undefined) return undefined
	const keys = [...path.matchAll(/\["([^"]+)"\]/g)].flatMap((entry) =>
		entry[1] === undefined ? [] : [entry[1]],
	)
	const field = keys[keys.length - 1]
	if (field === undefined) return undefined
	const expected = match[2]
	return expected === undefined ? `missing key \`${field}\`` : `\`${field}\`: expected ${expected.trim()}`
}

/** The completion tool a run ended without calling, when the message says. */
export function incompleteRunTool(text: string): string | undefined {
	const tool = INCOMPLETE.exec(text)?.[1]
	return tool === undefined ? undefined : tool.replace(/[.,;]+$/, "")
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
		const subject = span.genAi.toolName !== undefined ? "invalid arguments" : "output rejected by schema"
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
