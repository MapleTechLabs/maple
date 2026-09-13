import { Option, Schema } from "effect"

import { InlineErrorData, InlineLogData, InlineServiceData, InlineTraceData, type Segment } from "./types"

/**
 * Openers are deliberately loose. The prompt asks for `<<maple:type:{…}>>` on its
 * own line, but models routinely emit a single angle bracket, several cards on one
 * line, or a card mid-sentence — and anything the parser misses reaches the
 * markdown renderer, where `<maple:service:…>` reads as an unknown HTML tag and is
 * dropped. Accept every shape the model actually produces.
 */
const OPENER_RE = /<{1,2}maple:(trace|service|error|log):\s*/g

// `fromJsonString` folds the parse and the shape check into one decode, so a
// truncated or hallucinated payload comes back as `None` instead of throwing.
const decodeTrace = Schema.decodeUnknownOption(Schema.fromJsonString(InlineTraceData))
const decodeService = Schema.decodeUnknownOption(Schema.fromJsonString(InlineServiceData))
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(InlineErrorData))
const decodeLog = Schema.decodeUnknownOption(Schema.fromJsonString(InlineLogData))

/** Scans a balanced `{…}` starting at `start`, string- and escape-aware. */
function scanJsonObject(text: string, start: number): number | null {
	if (text[start] !== "{") return null
	let depth = 0
	let inString = false
	let escaped = false

	for (let i = start; i < text.length; i++) {
		const ch = text[i]
		if (escaped) {
			escaped = false
			continue
		}
		if (ch === "\\") {
			if (inString) escaped = true
			continue
		}
		if (ch === '"') {
			inString = !inString
			continue
		}
		if (inString) continue
		if (ch === "{") depth++
		else if (ch === "}") {
			depth--
			if (depth === 0) return i + 1
		}
	}
	return null
}

function decodeSegment(type: string, raw: string): Segment | null {
	switch (type) {
		case "trace": {
			const decoded = decodeTrace(raw)
			return Option.isSome(decoded) ? { type: "trace", data: decoded.value } : null
		}
		case "service": {
			const decoded = decodeService(raw)
			return Option.isSome(decoded) ? { type: "service", data: decoded.value } : null
		}
		case "error": {
			const decoded = decodeError(raw)
			return Option.isSome(decoded) ? { type: "error", data: decoded.value } : null
		}
		case "log": {
			const decoded = decodeLog(raw)
			return Option.isSome(decoded) ? { type: "log", data: decoded.value } : null
		}
		default:
			return null
	}
}

export function parseAnnotations(text: string): Segment[] {
	const segments: Segment[] = []
	let lastIndex = 0

	const pushText = (content: string) => {
		if (!content) return
		const previous = segments[segments.length - 1]
		if (previous?.type === "text") previous.content += content
		else segments.push({ type: "text", content })
	}

	OPENER_RE.lastIndex = 0
	let match: RegExpExecArray | null = OPENER_RE.exec(text)
	while (match !== null) {
		const matchStart = match.index
		const jsonStart = matchStart + match[0].length
		const jsonEnd = scanJsonObject(text, jsonStart)

		if (jsonEnd === null) {
			// Still streaming: the JSON body has not arrived yet. Hold the partial
			// opener back rather than flashing raw markup — the next token re-parses
			// the whole message anyway.
			pushText(text.slice(lastIndex, matchStart))
			return finish(segments, text)
		}

		let end = jsonEnd
		while (text[end] === ">") end++
		const segment = decodeSegment(match[1], text.slice(jsonStart, jsonEnd))

		if (segment === null) {
			// A payload that does not match its card stays visible as text, so a bad
			// shape is debuggable instead of silently missing.
			pushText(text.slice(lastIndex, end))
		} else {
			pushText(text.slice(lastIndex, matchStart))
			segments.push(segment)
			// Swallow one trailing newline so a card on its own line leaves no empty
			// paragraph behind it.
			if (text[end] === "\n") end++
		}

		lastIndex = end
		OPENER_RE.lastIndex = end
		match = OPENER_RE.exec(text)
	}

	pushText(text.slice(lastIndex))
	return finish(segments, text)
}

function finish(segments: Segment[], text: string): Segment[] {
	if (segments.length === 0) segments.push({ type: "text", content: text })
	return segments
}
