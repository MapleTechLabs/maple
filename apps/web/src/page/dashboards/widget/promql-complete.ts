import { parser } from "@prometheus-io/lezer-promql"
import { replaceWith } from "@maple/strings"
import { Array as Arr, Option, String as Str } from "effect"
import {
	lexPromql,
	PROMQL_AGGREGATIONS,
	PROMQL_KEYWORDS,
	type PromqlToken,
} from "@maple/views/lib/promql-highlight"

// The PromQL editor's language smarts, pure: a light lexer, where the caret sits (what it can
// complete), and the grammar's verdict with dashboard variables standing in as valid tokens.

const GROUPING = new Set(["by", "without", "on", "ignoring", "group_left", "group_right"])
const NOT_METRIC = new Set([...PROMQL_KEYWORDS, ...PROMQL_AGGREGATIONS, "inf", "nan"])
const MATCH_OPS = new Set(["=", "!=", "=~", "!~"])

/** What the caret can complete, and the span `[from, caret)` a pick replaces. */
export type PromqlCompletionContext =
	| Readonly<{ kind: "expression"; from: number; prefix: string }>
	| Readonly<{ kind: "operator"; from: number; prefix: string }>
	| Readonly<{ kind: "labelName"; from: number; prefix: string; metric: string | null }>
	| Readonly<{
			kind: "labelValue"
			from: number
			prefix: string
			metric: string | null
			label: string
			/** The quote the value is typed inside; null when a pick must add them. */
			quote: string | null
	  }>
	| Readonly<{ kind: "duration"; from: number; prefix: string }>
	| Readonly<{ kind: "variable"; from: number; prefix: string }>

type Frame =
	| Readonly<{ kind: "brace"; metric: string | null; label: string | null }>
	| Readonly<{ kind: "paren"; isGrouping: boolean }>
	| Readonly<{ kind: "bracket" }>

const significant = (tokens: ReadonlyArray<PromqlToken>) =>
	Arr.filter(tokens, (token) => token.kind !== "space" && token.kind !== "comment")

/** The open brackets around the end of `tokens`, innermost last, braces tracking their label. */
const framesOf = (tokens: ReadonlyArray<PromqlToken>): ReadonlyArray<Frame> => {
	const all = significant(tokens)
	return Arr.reduce(all, [] as ReadonlyArray<Frame>, (stack, token, index) => {
		const previous = index === 0 ? undefined : all[index - 1]
		const top = Arr.last(stack).pipe(Option.getOrUndefined)
		if (token.kind === "open") {
			const before = previous?.kind === "ident" ? previous.text : null
			const frame: Frame =
				token.text === "{"
					? {
							kind: "brace",
							metric: before !== null && !NOT_METRIC.has(before) ? before : null,
							label: null,
						}
					: token.text === "("
						? { kind: "paren", isGrouping: before !== null && GROUPING.has(before) }
						: { kind: "bracket" }
			return [...stack, frame]
		}
		if (token.kind === "close") return stack.slice(0, -1)
		if (top?.kind === "brace" && token.kind === "ident") {
			return [...stack.slice(0, -1), { ...top, label: token.text }]
		}
		// A quoted UTF-8 name: a label before a matcher, else the metric (`{"http.server.duration"}`).
		const isNamePosition = previous?.text === "{" || previous?.text === ","
		if (
			top?.kind === "brace" &&
			token.kind === "string" &&
			isNamePosition &&
			isClosedString(token.text)
		) {
			const name = unquote(token.text)
			const next = all[index + 1]
			return [
				...stack.slice(0, -1),
				next !== undefined && MATCH_OPS.has(next.text)
					? { ...top, label: name }
					: { ...top, metric: name },
			]
		}
		return stack
	})
}

const isClosedString = (text: string): boolean =>
	text.length > 1 && Str.endsWith(text[0] ?? '"')(text) && !Str.endsWith(`\\${text[0] ?? ""}`)(text)

const ESCAPES = new Map([
	["n", "\n"],
	["t", "\t"],
	["r", "\r"],
	["a", "\u0007"],
	["b", "\b"],
	["f", "\f"],
	["v", "\v"],
])
const ESCAPE = /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([0-7]{3})|(.))/g

/** A closed string's text without its quotes, its escapes decoded as PromQL reads them; raw in backticks. */
const unquote = (text: string): string => {
	const inner = Str.slice(1, -1)(text)
	return text[0] === "`"
		? inner
		: replaceWith(inner, ESCAPE, (_match, u4, u8, hex, octal, char) => {
				const code = u4 ?? u8 ?? hex
				if (code !== undefined) return String.fromCodePoint(Number.parseInt(code, 16))
				if (octal !== undefined) return String.fromCodePoint(Number.parseInt(octal, 8))
				const literal = char ?? ""
				return ESCAPES.get(literal) ?? literal
			})
}

/**
 * The one metric the query selects, or null when it selects none or several: a `by (...)` list is
 * then completed from every label rather than one metric's, which may be the wrong one.
 */
export const onlyMetricOf = (query: string): string | null => {
	const tokens = significant(lexPromql(query))
	const bare = Arr.filter(tokens, (token, index) => {
		if (token.kind !== "ident" || NOT_METRIC.has(token.text)) return false
		if (tokens[index + 1]?.text === "(") return false
		const top = Arr.last(framesOf(tokens.slice(0, index)))
		return Option.match(top, {
			onNone: () => true,
			onSome: (frame) => frame.kind === "paren" && !frame.isGrouping,
		})
	})
	const braced = Arr.flatMap(tokens, (token, index) => {
		if (token.text !== "}") return []
		const frame = Arr.last(framesOf(tokens.slice(0, index))).pipe(Option.getOrUndefined)
		return frame?.kind === "brace" && frame.metric !== null ? [frame.metric] : []
	})
	const metrics = Arr.dedupe([...Arr.map(bare, (token) => token.text), ...braced])
	return metrics.length === 1 ? (metrics[0] ?? null) : null
}

const isOperand = (token: PromqlToken | undefined): boolean =>
	token !== undefined &&
	(token.kind === "close" ||
		token.kind === "number" ||
		token.kind === "string" ||
		token.kind === "variable" ||
		(token.kind === "ident" && !NOT_METRIC.has(token.text)))

/** What the caret at `caret` can complete, or null where nothing fits (a comment, a number). */
export const completionContextAt = (query: string, caret: number): PromqlCompletionContext | null => {
	const tokens = lexPromql(Str.slice(0, caret)(query))
	const last = Arr.last(tokens).pipe(Option.getOrUndefined)
	const current =
		last !== undefined && (last.kind === "ident" || last.kind === "variable" || last.kind === "string")
			? last
			: undefined
	const before = current === undefined ? tokens : tokens.slice(0, -1)
	const previous = Arr.last(significant(before)).pipe(Option.getOrUndefined)
	const top = Arr.last(framesOf(before)).pipe(Option.getOrUndefined)
	const from = current?.start ?? caret
	const prefix = current?.text ?? ""
	if (last?.kind === "comment" || last?.kind === "number") return null
	if (current?.kind === "variable") return { kind: "variable", from, prefix }
	if (top?.kind === "brace") {
		if (current?.kind === "string") {
			const quote = current.text[0] ?? '"'
			if (
				isClosedString(current.text) ||
				top.label === null ||
				previous === undefined ||
				!MATCH_OPS.has(previous.text)
			)
				return null
			return {
				kind: "labelValue",
				from: from + 1,
				prefix: Str.slice(1)(current.text),
				metric: top.metric,
				label: top.label,
				quote,
			}
		}
		if (previous !== undefined && MATCH_OPS.has(previous.text) && top.label !== null) {
			return { kind: "labelValue", from, prefix, metric: top.metric, label: top.label, quote: null }
		}
		return previous?.text === "{" || previous?.text === ","
			? { kind: "labelName", from, prefix, metric: top.metric }
			: null
	}
	if (current?.kind === "string") return null
	if (top?.kind === "paren" && top.isGrouping) {
		return { kind: "labelName", from, prefix, metric: onlyMetricOf(query) }
	}
	if (top?.kind === "bracket") return { kind: "duration", from, prefix }
	if (isOperand(previous) && (current === undefined ? last?.kind === "space" : true)) {
		return { kind: "operator", from, prefix }
	}
	if (current === undefined && isOperand(previous)) return null
	return { kind: "expression", from, prefix }
}

/** A parse failure as the editor marks it: the message, and the span `[from, to)` it points at. */
export type PromqlParseError = Readonly<{ message: string; from: number; to: number }>

/**
 * A same-length stand-in for a variable: digits when a unit follows it (`${__interval_ms}ms`), a
 * duration where one goes, else a name.
 */
const placeholderFor = (
	token: PromqlToken,
	previous: PromqlToken | undefined,
	next: PromqlToken | undefined,
): string => {
	const size = token.text.length
	if (next?.kind === "ident" && next.start === token.start + size) return `${Str.repeat(size - 1)("0")}1`
	// A duration needs two characters; a lone `$` stays a name, so every offset still maps back.
	const isDuration =
		size >= 2 && (previous?.text === "[" || previous?.text === ":" || previous?.text === "offset")
	return isDuration ? `${Str.repeat(size - 2)("0")}1m` : `x${Str.repeat(size - 1)("_")}`
}

// Prometheus reads `1.` and `1.e2` as numbers; the grammar wants a digit after the dot.
const TRAILING_DOT = /(?<![\w:.])(\d[\d_]*)\.(?![\d_.])([eE][+-]?\d[\d_]*)?/g

/** The trailing dot dropped and the number padded, so every offset stays where it was. */
const withoutTrailingDots = (source: string): string =>
	replaceWith(source, TRAILING_DOT, (_match, integer, exponent) => `${integer ?? ""}${exponent ?? ""} `)

/** Where the grammar first gave up, as Prometheus reports it, or null when the text parses. */
const syntaxErrorOf = (source: string): Readonly<{ from: number; to: number }> | null => {
	const found: Array<Readonly<{ from: number; to: number }>> = []
	parser.parse(source).iterate({
		enter: (node) => {
			if (found.length > 0) return false
			if (node.type.isError) found.push({ from: node.from, to: node.to })
			return undefined
		},
	})
	return found[0] ?? null
}

/**
 * The grammar's verdict on the query, or null when it parses (or is empty). A variable becomes a
 * same-length valid token first, and an error inside one is left to the server, which knows its
 * value. Type errors (`rate()` of an instant vector) come from the server on Run preview: the full
 * checker would put its regex engine in the dashboard bundle.
 */
export const promqlParseError = (query: string): PromqlParseError | null => {
	if (Str.trim(query) === "") return null
	const tokens = lexPromql(query)
	const variables = Arr.filter(tokens, (token) => token.kind === "variable")
	const substituted = Arr.join(
		Arr.map(tokens, (token, index) =>
			token.kind === "variable"
				? placeholderFor(
						token,
						Arr.last(significant(tokens.slice(0, index))).pipe(Option.getOrUndefined),
						tokens[index + 1],
					)
				: token.text,
		),
		"",
	)
	const error = syntaxErrorOf(withoutTrailingDots(substituted))
	if (error === null) return null
	const at = Math.min(error.from, query.length)
	if (Arr.some(variables, (token) => at >= token.start && at < token.start + token.text.length)) return null
	const near = Str.trim(Str.slice(at, Math.max(error.to, at + 1))(query))
	const token = Arr.findFirst(
		tokens,
		(t) => at >= t.start && at < t.start + t.text.length && t.kind !== "space",
	)
	const to = Option.match(token, { onNone: () => at, onSome: (t) => t.start + t.text.length })
	return {
		message: near === "" ? "unexpected end of input" : `syntax error near "${near}"`,
		from: at,
		to,
	}
}
