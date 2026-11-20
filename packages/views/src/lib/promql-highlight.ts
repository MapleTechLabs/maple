import { Array as Arr, Option, String as Str } from "effect"
import { typographyClass } from "../ui/typography"
import type { CodeToken } from "../ui/code-editor"

// A light PromQL lexer and the editor's highlighting over it. Unclosed strings and `${` lex as
// tokens, so a query being typed still colours and completes.

export type PromqlTokenKind =
	| "comment"
	| "string"
	| "variable"
	| "ident"
	| "number"
	| "open"
	| "close"
	| "op"
	| "space"
	| "other"

export type PromqlToken = Readonly<{ kind: PromqlTokenKind; text: string; start: number }>

const LEX =
	/(#[^\n]*)|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`[^`]*`?)|(\$\{[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z]+)?\}?|\[\[[A-Za-z_][A-Za-z0-9_]*\]\]|\$[A-Za-z_][A-Za-z0-9_]*|\$\{?)|([A-Za-z_:][A-Za-z0-9_:.]*)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[a-z]*)|([{([])|([})\]])|(=~|!~|!=|==|>=|<=|[=<>+\-*/%^,@])|(\s+)|([^])/g

const KINDS: ReadonlyArray<PromqlTokenKind> = [
	"comment",
	"string",
	"variable",
	"ident",
	"number",
	"open",
	"close",
	"op",
	"space",
	"other",
]

/** The query as tokens, every character in exactly one. */
export const lexPromql = (query: string): ReadonlyArray<PromqlToken> =>
	Arr.map(Arr.fromIterable(Str.matchAll(LEX)(query)), (match) => {
		const group = Arr.findFirstIndex(match.slice(1), (text) => text !== undefined)
		return {
			kind: KINDS[Option.getOrElse(group, () => KINDS.length - 1)] ?? "other",
			text: match[0],
			start: match.index ?? 0,
		}
	})

/** Words PromQL reads as operators or modifiers, never as a metric name. */
export const PROMQL_KEYWORDS: ReadonlySet<string> = new Set([
	"by",
	"without",
	"on",
	"ignoring",
	"group_left",
	"group_right",
	"and",
	"or",
	"unless",
	"offset",
	"bool",
	"atan2",
])

/** The aggregation operators, which read as calls even before their `by (...)`. */
export const PROMQL_AGGREGATIONS: ReadonlySet<string> = new Set([
	"sum",
	"avg",
	"min",
	"max",
	"count",
	"group",
	"stddev",
	"stdvar",
	"topk",
	"bottomk",
	"quantile",
	"count_values",
	"limitk",
	"limit_ratio",
])

const MATCH_OPS = new Set(["=", "!=", "=~", "!~"])

const nextSignificant = (tokens: ReadonlyArray<PromqlToken>, index: number): PromqlToken | undefined =>
	Arr.findFirst(tokens.slice(index + 1), (token) => token.kind !== "space").pipe(Option.getOrUndefined)

const identClass = (tokens: ReadonlyArray<PromqlToken>, index: number, text: string): string | undefined => {
	const next = nextSignificant(tokens, index)
	if (PROMQL_KEYWORDS.has(text)) return "text-chart-5"
	if (PROMQL_AGGREGATIONS.has(text) || next?.text === "(") return "text-chart-1"
	if (next !== undefined && MATCH_OPS.has(next.text)) return "text-chart-3"
	return undefined
}

const classOf = (tokens: ReadonlyArray<PromqlToken>, index: number): string | undefined => {
	const token = tokens[index]
	switch (token?.kind) {
		case "comment":
			return typographyClass({ tone: "subtle", className: "italic" })
		case "string":
			return "text-severity-info"
		case "variable":
			return "text-primary font-medium"
		case "number":
			return "text-chart-4"
		case "op":
			return "text-muted-foreground"
		case "ident":
			return identClass(tokens, index, token.text)
		default:
			return undefined
	}
}

/** PromQL as coloured runs: keywords, calls, label names, strings, numbers, variables, comments. */
export const tokenizePromql = (query: string): ReadonlyArray<CodeToken> => {
	const tokens = lexPromql(query)
	return Arr.map(tokens, (token, index) => {
		const className = classOf(tokens, index)
		return className === undefined
			? { text: token.text, start: token.start }
			: { text: token.text, start: token.start, className }
	})
}
