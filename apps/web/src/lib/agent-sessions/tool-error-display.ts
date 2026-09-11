// How a tool failure reads on the page: the rules between an error group's raw
// text — and a failed call's arguments — and what the Errors table and its
// modal draw.
//
// The warehouse groups failures by `ErrorFingerprint`, a hash of the failure's
// text after the redactions `error_events` applies to messages. Everything
// here is display: it never decides what belongs to a group, only how a group
// that already exists is written down. The redactions are read from the same
// list the fingerprint's SQL is generated from, so a chip on the page marks a
// span of text the grouping really did ignore.

import { MSG_TEXT_REDACTIONS } from "@maple/domain/tinybird/fingerprint"

/* -------------------------------------------------------------------------------------------------
 * The message
 * -----------------------------------------------------------------------------------------------*/

/** A tool result's error envelope keys, in the order they are read. */
const ENVELOPE_KEYS = ["result", "error", "message"] as const

/** A parsed JSON document — what a tool call's arguments and result are. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<JsonValue>
	| { readonly [key: string]: JsonValue }

const parseJson = (text: string): JsonValue | undefined => {
	try {
		const value: JsonValue = JSON.parse(text)
		return value
	} catch {
		return undefined
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The message inside a tool result's JSON envelope — `{"result": "…"}`, and the
 * `error` / `message` / `error.message` spellings — or the text as it came.
 *
 * `source` names where it was read from, for the note under the result block.
 */
export function unwrapToolErrorText(raw: string): { readonly text: string; readonly source?: string } {
	if (!raw.trimStart().startsWith("{")) return { text: raw }
	const parsed = parseJson(raw)
	if (!isRecord(parsed)) return { text: raw }
	for (const key of ENVELOPE_KEYS) {
		const value = parsed[key]
		if (typeof value === "string" && value !== "") return { text: value, source: `result.${key}` }
		if (isRecord(value) && typeof value.message === "string" && value.message !== "") {
			return { text: value.message, source: `result.${key}.message` }
		}
	}
	return { text: raw }
}

/**
 * The prefix every group of a tool shares, cut back to its last `": "` — the
 * part the Errors table hoists into its header ("all start “Invalid tool
 * input:”") so each row starts where the groups differ.
 *
 * Nothing for a single group, and nothing where a row would be left empty.
 */
export function commonErrorPrefix(texts: ReadonlyArray<string>): string {
	const [first, ...rest] = texts
	if (first === undefined || rest.length === 0) return ""
	let length = first.length
	for (const text of rest) {
		let index = 0
		while (index < length && index < text.length && first[index] === text[index]) index++
		length = index
	}
	const cut = first.slice(0, length).lastIndexOf(": ")
	if (cut <= 0) return ""
	const prefix = first.slice(0, cut + 2)
	return texts.every((text) => text.length > prefix.length) ? prefix : ""
}

/** One run of a message, as a row draws it. */
export type ErrorTextToken =
	| { readonly kind: "text"; readonly text: string }
	/** A value the message is about: a backticked name, a quoted bad value, a first line. */
	| { readonly kind: "value"; readonly text: string }
	/** Text the fingerprint ignores, drawn as a quiet placeholder. */
	| { readonly kind: "mask"; readonly label: string; readonly raw: string }
	/** The `at` before an error path. */
	| { readonly kind: "at" }
	| { readonly kind: "path"; readonly parts: ReadonlyArray<ErrorPathPart> }
	/** A line break the row folds onto one line. */
	| { readonly kind: "break" }

export type ErrorPathPart =
	| { readonly kind: "key"; readonly text: string }
	| { readonly kind: "mask"; readonly label: string; readonly raw: string }

/** ` at ["evidence"][0]["traceIds"]` — a schema decoder's path, the part of a
 *  message that says where. Also on its own line (`\n  at [...]`). */
const AT_PATH = /\s*\bat ((?:\[(?:"(?:[^"\\\n]|\\.)*"|\d+)\])+)/g
const PATH_SEGMENT = /\[(?:"((?:[^"\\\n]|\\.)*)"|(\d+))\]/g
const TIMESTAMPS = /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g

/**
 * The placeholder a redacted span is drawn as.
 *
 * The last redaction (`[0-9a-fA-F-]{6,}|[0-9]+` → `#`) is most of them, and
 * says three different things on screen: an array index, a number, an id. Two
 * of its matches stay text: a hex-letter word with no digit in it ("facade"),
 * and digits inside a longer identifier (`01M1XS…`) — the grouping masks those
 * digits but keeps the letters around them, so a chip would claim the whole
 * identifier was ignored when it was not.
 */
const maskLabel = (raw: string, replacement: string, before: string, after: string): string | undefined => {
	switch (replacement) {
		case "EMAIL":
			return "<email>"
		case "":
			return "<url>"
		case "/~":
			return "~"
		case "?#":
			return "?…"
		case "#":
			if (!/\d/.test(raw) || /\w/.test(before) || /\w/.test(after)) return undefined
			return /^\d+$/.test(raw) ? "<n>" : "<id>"
		default:
			// The quoted-literal redactions keep their quote character.
			return `${replacement[0]}…${replacement[0]}`
	}
}

interface Claim {
	readonly start: number
	readonly end: number
	readonly label: string
}

/**
 * Where each redaction matches, earliest pattern first, never overlapping.
 *
 * Timestamps are claimed before any of them: `2026-09-04 00:00` is three `#`s
 * to the redactions and one timestamp to a reader.
 */
function redactedRanges(text: string): ReadonlyArray<Claim> {
	const claims: Claim[] = [...text.matchAll(TIMESTAMPS)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
		label: "<ts>",
	}))
	for (const [pattern, replacement] of MSG_TEXT_REDACTIONS) {
		for (const match of text.matchAll(new RegExp(pattern, "g"))) {
			const start = match.index
			const end = start + match[0].length
			if (end === start || claims.some((claim) => start < claim.end && end > claim.start)) continue
			const label = maskLabel(match[0], replacement, text[start - 1] ?? "", text[end] ?? "")
			if (label !== undefined) claims.push({ start, end, label })
		}
	}
	return claims.sort((a, b) => a.start - b.start)
}

/** An index inside brackets is the same bug at another position: `[*]`. */
function withIndexMasks(text: string, claims: ReadonlyArray<Claim>): ReadonlyArray<Claim> {
	return claims.map((claim) =>
		claim.label === "<n>" && text[claim.start - 1] === "[" && text[claim.end] === "]"
			? { start: claim.start - 1, end: claim.end + 1, label: "[*]" }
			: claim,
	)
}

/** Backticked names, and a bare quoted value after a space — `Invalid group_by "service.version"`. */
const EMPHASIS = /`[^`\n]+`|(?<= )"[^"\n]*"|\n/g

function plainTokens(text: string, emphasizeQuoted: { value: boolean }): ErrorTextToken[] {
	const tokens: ErrorTextToken[] = []
	let cursor = 0
	for (const match of text.matchAll(EMPHASIS)) {
		if (match.index > cursor) tokens.push({ kind: "text", text: text.slice(cursor, match.index) })
		const value = match[0]
		if (value === "\n") tokens.push({ kind: "break" })
		else if (value.startsWith('"') && !emphasizeQuoted.value) tokens.push({ kind: "text", text: value })
		else {
			if (value.startsWith('"')) emphasizeQuoted.value = false
			tokens.push({ kind: "value", text: value })
		}
		cursor = match.index + value.length
	}
	if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) })
	return tokens
}

function outsideTokens(text: string, emphasizeQuoted: { value: boolean }): ErrorTextToken[] {
	const tokens: ErrorTextToken[] = []
	let cursor = 0
	for (const claim of withIndexMasks(text, redactedRanges(text))) {
		tokens.push(...plainTokens(text.slice(cursor, claim.start), emphasizeQuoted))
		tokens.push({ kind: "mask", label: claim.label, raw: text.slice(claim.start, claim.end) })
		cursor = claim.end
	}
	tokens.push(...plainTokens(text.slice(cursor), emphasizeQuoted))
	return tokens
}

/**
 * A message as the Errors table and the modal header draw it: the error path
 * picked out, the values it names emphasized, the spans the grouping ignores
 * as chips, and line breaks kept as marks rather than wrapped lines.
 *
 * A message with a line break of its own (not the one before `at`) emphasizes
 * its first line — that is the error's name; the rest is its detail.
 */
export function errorTextTokens(text: string): ReadonlyArray<ErrorTextToken> {
	const tokens: ErrorTextToken[] = []
	// The first bare quoted value is the bad one — unless the message has a path,
	// which is then what it is about.
	const emphasizeQuoted = { value: !new RegExp(AT_PATH.source).test(text) }
	let cursor = 0
	for (const match of text.matchAll(AT_PATH)) {
		tokens.push(...outsideTokens(text.slice(cursor, match.index), emphasizeQuoted))
		tokens.push({ kind: "at" })
		const path = match[1]!
		tokens.push({
			kind: "path",
			parts: [...path.matchAll(PATH_SEGMENT)].map((segment) =>
				segment[2] === undefined
					? { kind: "key" as const, text: segment[0] }
					: { kind: "mask" as const, label: "[*]", raw: segment[0] },
			),
		})
		cursor = match.index + match[0].length
	}
	tokens.push(...outsideTokens(text.slice(cursor), emphasizeQuoted))

	const firstBreak = tokens.findIndex((token) => token.kind === "break")
	if (firstBreak <= 0) return tokens.filter((token) => !(token.kind === "text" && token.text === ""))
	return tokens
		.map((token, index) =>
			index < firstBreak && token.kind === "text" ? { kind: "value" as const, text: token.text } : token,
		)
		.filter((token) => !((token.kind === "text" || token.kind === "value") && token.text.trim() === ""))
}

/* -------------------------------------------------------------------------------------------------
 * The error path, against the arguments
 * -----------------------------------------------------------------------------------------------*/

export type ErrorPath = ReadonlyArray<string | number>

/** The last `at [...]` path of a message, as keys and indices. */
export function parseErrorPath(text: string): ErrorPath | undefined {
	const matches = [...text.matchAll(AT_PATH)]
	const last = matches[matches.length - 1]
	if (last === undefined) return undefined
	return [...last[1]!.matchAll(PATH_SEGMENT)].map((segment) =>
		segment[2] === undefined ? String(parseJson(`"${segment[1]}"`) ?? segment[1]) : Number(segment[2]),
	)
}

/** `evidence[0].traceIds` — a path as the hint writes it. */
export function formatErrorPath(path: ErrorPath): string {
	return path
		.map((segment, index) =>
			typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
		)
		.join("")
}

/** The value at a path, and whether the path exists at all. */
export function resolveErrorPath(
	value: unknown,
	path: ErrorPath,
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
	let current = value
	for (const segment of path) {
		if (typeof segment === "number") {
			if (!Array.isArray(current) || segment >= current.length) return { found: false }
			current = current[segment]
		} else {
			if (!isRecord(current) || !Object.hasOwn(current, segment)) return { found: false }
			current = current[segment]
		}
	}
	return { found: true, value: current }
}

/** What a hint says, with the value it names emphasized. */
export interface WhatsWrongHint {
	readonly subject: string
	readonly text: string
}

const EXPECTED = /\bExpected (array|object)\b/
const MISSING_KEY = /\bMissing key\b/

/**
 * A plain-language reading of a schema decoder's failure, where the arguments
 * confirm it — and nothing otherwise.
 *
 * Two shapes are certain enough to state: a value the schema expected as an
 * array or object that arrived as a STRING holding one (the model quoted the
 * JSON), and a missing key the arguments really do not have. Any other failure
 * gets no hint rather than a guess.
 */
export function whatsWrong(text: string, args: unknown): WhatsWrongHint | undefined {
	const path = parseErrorPath(text)
	if (path === undefined || path.length === 0 || args === undefined) return undefined

	const expected = EXPECTED.exec(text)?.[1]
	if (expected !== undefined) {
		const resolved = resolveErrorPath(args, path)
		if (!resolved.found || typeof resolved.value !== "string") return undefined
		const inner = parseJson(resolved.value)
		const holds = expected === "array" ? Array.isArray(inner) : isRecord(inner)
		if (!holds) return undefined
		return {
			subject: formatErrorPath(path),
			text: `is a string that contains a JSON ${expected}. The schema expects the ${expected} itself — it was sent quoted.`,
		}
	}

	if (MISSING_KEY.test(text)) {
		const key = path[path.length - 1]
		const parentPath = path.slice(0, -1)
		const parent = resolveErrorPath(args, parentPath)
		if (typeof key !== "string" || !parent.found || !isRecord(parent.value) || Object.hasOwn(parent.value, key)) {
			return undefined
		}
		if (parentPath.length === 0) {
			return { subject: key, text: "is required, and the arguments have no such key." }
		}
		const owner = parentPath[parentPath.length - 1]
		const collection = parentPath[parentPath.length - 2]
		return {
			subject: formatErrorPath(parentPath),
			text:
				typeof owner === "number" && typeof collection === "string"
					? `has no ${key} key, which is required on every ${collection} item.`
					: `has no ${key} key, which the schema requires.`,
		}
	}
	return undefined
}

/** A variant's text around where it differs from the group's other variants. */
export interface VariantDifference {
	readonly before: string
	readonly middle: string
	readonly after: string
}

/** Context kept either side of where variants differ — a rail's worth. */
const VARIANT_CONTEXT = 10

/**
 * Where each of a group's raw texts differs from the others — `[0]`, `[1]`,
 * `[2]` of one missing key — with just enough around it to place it: the error
 * path it sits in, or a few characters either side.
 */
export function variantDifferences(texts: ReadonlyArray<string>): ReadonlyArray<VariantDifference> {
	if (texts.length < 2) return texts.map((text) => ({ before: "", middle: text, after: "" }))
	const shortest = Math.min(...texts.map((text) => text.length))
	let start = 0
	while (start < shortest && texts.every((text) => text[start] === texts[0]![start])) start++
	let end = 0
	while (
		end < shortest - start &&
		texts.every((text) => text[text.length - 1 - end] === texts[0]![texts[0]!.length - 1 - end])
	) {
		end++
	}
	return texts.map((text) => {
		let from = start
		let to = text.length - end
		// An index reads as `[0]`, not `0`.
		if (text[from - 1] === "[" && text[to] === "]") {
			from -= 1
			to += 1
		}
		const prefix = text.slice(0, from).replace(/\s+/g, " ")
		const at = prefix.lastIndexOf(" at ")
		const suffix = text.slice(to).replace(/\s+/g, " ")
		// The rest of a path the difference sits in reads to its end, whole.
		const pathTail = /^(?:\[(?:"(?:[^"\\]|\\.)*"|\d+)\])+/.exec(suffix)?.[0]
		return {
			before:
				at >= 0
					? prefix.slice(at + 4)
					: prefix.length > VARIANT_CONTEXT
						? `…${prefix.slice(-VARIANT_CONTEXT)}`
						: prefix,
			middle: text.slice(from, to),
			after:
				pathTail ?? (suffix.length > VARIANT_CONTEXT ? `${suffix.slice(0, VARIANT_CONTEXT)}…` : suffix),
		}
	})
}

/* -------------------------------------------------------------------------------------------------
 * The arguments block
 * -----------------------------------------------------------------------------------------------*/

/** One line of a payload as the sample draws it. */
export interface PayloadLine {
	readonly depth: number
	readonly text: string
	/** Inside the value the error path names. */
	readonly highlight: boolean
	/** Under the highlighted value: what it is and what was expected, and how
	 *  much of it the line leaves out. */
	readonly note?: { readonly text: string; readonly hiddenBytes: number }
	/** The key the schema wanted and the object does not have. */
	readonly missingKey?: string
	/** A sibling of the path, folded to one line: "item [1] · 612 B". */
	readonly folded?: string
}

/** A string off the path is cut here; the one the path names keeps more. */
const STRING_MAX = 120
const PATH_STRING_MAX = 160

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

const shorten = (value: string, max: number): { readonly text: string; readonly hiddenBytes: number } => {
	const json = JSON.stringify(value)
	if (value.length <= max) return { text: json, hiddenBytes: 0 }
	const kept = JSON.stringify(value.slice(0, max))
	return { text: `${kept.slice(0, -1)} …"`, hiddenBytes: utf8Bytes(json) - utf8Bytes(kept) }
}

const describeType = (value: unknown): string =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value

/** `{ "logPatterns": […], "note": "…" }` — a value's shape without its contents. */
const outlineOf = (value: unknown): string => {
	if (Array.isArray(value)) return "[…]"
	if (isRecord(value)) {
		return `{ ${Object.entries(value)
			.map(([key, inner]) => `${JSON.stringify(key)}: ${outlineOf(inner)}`)
			.join(", ")} }`
	}
	return typeof value === "string" ? '"…"' : JSON.stringify(value)
}

const samePath = (a: ErrorPath, b: ErrorPath) => a.length === b.length && a.every((segment, i) => segment === b[i])
const isPrefix = (prefix: ErrorPath, path: ErrorPath) =>
	prefix.length <= path.length && prefix.every((segment, i) => segment === path[i])

/**
 * A parsed payload as lines, shortened around the error path.
 *
 * The value the path names is highlighted — and for a missing key, the object
 * that lacks it, with the key written in where it should be. Long strings are
 * cut; the path's own string keeps more of itself and says how much it left
 * out. The items of an array the path runs through that are NOT on it fold to
 * their shape, so the item that failed is the one the eye lands on.
 */
export function payloadLines(value: unknown, message: string): ReadonlyArray<PayloadLine> {
	const path = parseErrorPath(message) ?? []
	const missing = path.length > 0 && MISSING_KEY.test(message)
	const target = missing ? path.slice(0, -1) : path
	const expected = EXPECTED.exec(message)?.[1]
	const lines: PayloadLine[] = []

	const walk = (node: unknown, at: ErrorPath, depth: number, label: string, comma: string, lit: boolean) => {
		const isTarget = path.length > 0 && samePath(at, target)
		const highlight = lit || isTarget
		const onPath = path.length > 0 && isPrefix(at, path)

		if (Array.isArray(node) || isRecord(node)) {
			const [open, close] = Array.isArray(node) ? ["[", "]"] : ["{", "}"]
			const entries: ReadonlyArray<readonly [string | number, unknown]> = Array.isArray(node)
				? node.map((item, index) => [index, item] as const)
				: Object.entries(node)
			lines.push({ depth, text: `${label}${open}`, highlight })
			entries.forEach(([key, inner], index) => {
				const innerComma = index < entries.length - 1 ? "," : ""
				const innerAt = [...at, key]
				// A sibling item of an array the path runs through: its shape alone.
				if (Array.isArray(node) && onPath && !isPrefix(innerAt, path) && !highlight) {
					lines.push({
						depth: depth + 1,
						text: `${outlineOf(inner)}${innerComma}`,
						highlight: false,
						folded: `item [${key}] · ${utf8Bytes(JSON.stringify(inner)).toLocaleString()} B`,
					})
					return
				}
				const innerLabel = Array.isArray(node) ? "" : `${JSON.stringify(key)}: `
				walk(inner, innerAt, depth + 1, innerLabel, innerComma, highlight)
			})
			if (isTarget && missing) {
				lines.push({ depth: depth + 1, text: "", highlight: true, missingKey: String(path[path.length - 1]) })
			}
			lines.push({ depth, text: `${close}${comma}`, highlight })
			return
		}

		if (typeof node === "string") {
			const shortened = shorten(node, isTarget ? PATH_STRING_MAX : STRING_MAX)
			lines.push({
				depth,
				text: `${label}${shortened.text}${comma}`,
				highlight,
				...(isTarget &&
					!missing && {
						note: {
							text: expected === undefined ? "string" : `string, expected ${expected}`,
							hiddenBytes: shortened.hiddenBytes,
						},
					}),
			})
			return
		}

		lines.push({
			depth,
			text: `${label}${JSON.stringify(node)}${comma}`,
			highlight,
			...(isTarget &&
				!missing &&
				expected !== undefined && {
					note: { text: `${describeType(node)}, expected ${expected}`, hiddenBytes: 0 },
				}),
		})
	}

	walk(value, [], 0, "", "", false)
	return lines
}

/** The bytes a set of lines shows, for "Showing 412 of 2,753 B". */
export const payloadLinesBytes = (lines: ReadonlyArray<PayloadLine>): number =>
	lines.reduce((sum, line) => sum + utf8Bytes(line.text) + line.depth * 2, 0)

/** A payload that parses as JSON, or `undefined` for one that does not — which
 *  includes one the read truncated. */
export function parsePayload(text: string): JsonValue | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
	return parseJson(trimmed)
}

/* -------------------------------------------------------------------------------------------------
 * Stopped or still happening
 * -----------------------------------------------------------------------------------------------*/

export type FailureStatus =
	/** Enough calls since the last failure that its absence means something. */
	| { readonly kind: "stopped"; readonly since: number; readonly callsSince: number }
	/** Failing as recently as the tool has been used. */
	| { readonly kind: "ongoing"; readonly lastSeen: number }
	/** Not called since it last failed — silence without traffic is not a fix. */
	| { readonly kind: "quiet"; readonly since: number }

/**
 * Failed calls a group would have repeated, at its own rate over the window, in
 * the calls made since its last one — the evidence "stopped" needs. At three, a
 * group still failing at its window rate goes that quiet by chance about one
 * time in twenty.
 */
const STOPPED_EXPECTED_FAILURES = 3

/** A last failure this recent is happening now, whatever came after it. */
const ONGOING_WITHIN_MS = 60 * 60_000

/**
 * Whether a group — or a whole tool — has stopped failing.
 *
 * Silence alone is not the test: a failure that is one call in two hundred
 * goes a day without happening all the time. So the calls since the last
 * failure are weighed against how often it failed over the window, and a
 * tool nobody has called since reads as quiet rather than fixed.
 */
export function failureStatus(input: {
	readonly lastSeen: number
	readonly callsSince: number
	/** This group's failed calls in the window (every failure, for a tool). */
	readonly failures: number
	/** The tool's calls in the window. */
	readonly calls: number
	readonly nowMs: number
}): FailureStatus {
	if (input.nowMs - input.lastSeen < ONGOING_WITHIN_MS) return { kind: "ongoing", lastSeen: input.lastSeen }
	if (input.callsSince === 0) return { kind: "quiet", since: input.lastSeen }
	const expected = input.calls > 0 ? (input.callsSince * input.failures) / input.calls : 0
	return expected >= STOPPED_EXPECTED_FAILURES
		? { kind: "stopped", since: input.lastSeen, callsSince: input.callsSince }
		: { kind: "ongoing", lastSeen: input.lastSeen }
}

/* -------------------------------------------------------------------------------------------------
 * The trend
 * -----------------------------------------------------------------------------------------------*/

const HOUR = 3_600

/** The trend's bucket for a window, and what one bucket is called. A week
 *  reads in days — eight bars, which is what a row's sparkline has room for. */
export function errorTrendBucket(startMs: number, endMs: number): { readonly seconds: number; readonly unit: string } {
	const hours = (endMs - startMs) / (HOUR * 1000)
	if (hours <= 6) return { seconds: HOUR / 2, unit: "30 min" }
	if (hours <= 24) return { seconds: 3 * HOUR, unit: "3 hours" }
	if (hours <= 72) return { seconds: 12 * HOUR, unit: "12 hours" }
	if (hours <= 31 * 24) return { seconds: 24 * HOUR, unit: "day" }
	return { seconds: 7 * 24 * HOUR, unit: "week" }
}

/**
 * A trend over every bucket of the window, zeros included, oldest first.
 *
 * Buckets are the warehouse's `toStartOfInterval`, which snaps to multiples of
 * the interval since the epoch — so the window's own edges are snapped the same
 * way, or the first bar would be a fraction of a bucket drawn as a whole one.
 */
export function fillTrend(
	trend: ReadonlyArray<{ readonly bucket: number; readonly calls: number }>,
	startMs: number,
	endMs: number,
	seconds: number,
): ReadonlyArray<number> {
	const step = seconds * 1000
	const first = Math.floor(startMs / step) * step
	const counts = new Map(trend.map((point) => [point.bucket, point.calls]))
	const out: number[] = []
	for (let bucket = first; bucket <= endMs; bucket += step) out.push(counts.get(bucket) ?? 0)
	return out
}
