// Grafana-style template variables in a PromQL widget query. Pure.
//
// Dashboard variables (`$var`, `${var}`, `${var:regex}`, `[[var]]`) are filled by the
// widget planner; the built-ins (`$__interval`, `$__rate_interval`, `$__range`, ...) need
// the step, so the executor fills them once it has picked one.
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { replaceWith } from "@maple/strings"
import type { VariableValues } from "../dashboard-variables/interpolate"
import { MAX_PROMQL_READ_WINDOW_SECONDS } from "../limits"

// `${name:format}` and `${name}` before bare `$name`, so a branch consumes its braces.
const PROMQL_VAR_REF =
	/\$\{([A-Za-z][A-Za-z0-9_]*)(?::([A-Za-z]+))?\}|\[\[([A-Za-z][A-Za-z0-9_]*)\]\]|\$([A-Za-z][A-Za-z0-9_]*)/g

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\-]/g

/** A value escaped for a RE2 regex: what `=~` and `!~` matchers take. */
export const promqlRegexEscape = (value: string): string =>
	replaceWith(value, REGEX_SPECIALS, (match) => `\\${match}`)

/** Where in a query a variable sits: PromQL code, or inside a string with that quote. */
type QuoteContext = "code" | '"' | "'" | "`"

/** Code that opens a string as the value of a `=~` or `!~` matcher, once its comments are gone. */
const OPENS_REGEX_MATCHER = /[=!]~\s*["'`]$/
const PROMQL_COMMENT = /#[^\n]*/g

/** A value escaped for the inside of a double- or single-quoted PromQL string (no raw newline). */
export const promqlStringEscape = (value: string, quote: '"' | "'" = '"'): string =>
	replaceWith(value, quote === '"' ? /[\\"\n]/g : /[\\'\n]/g, (match) =>
		match === "\n" ? "\\n" : `\\${match}`,
	)

/**
 * Outside a string a value may only be one whole token: a name, an unsigned number or a duration.
 * Anything that could tokenize as two (`1-2`, `a b`) is refused.
 */
const SAFE_TOKEN =
	/^(?:[A-Za-z_:][A-Za-z0-9_:]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|(?:\d+(?:ms|s|m|h|d|w|y))+)$/

const DURATION = /^(?:\d+(?:ms|s|m|h|d|w|y))+$/
const DURATION_PART = /(\d+)(ms|s|m|h|d|w|y)/g
const UNIT_MS = new Map([
	["ms", 1],
	["s", 1_000],
	["m", 60_000],
	["h", 3_600_000],
	["d", 86_400_000],
	["w", 604_800_000],
	["y", 31_536_000_000],
])

/** A PromQL duration in ms, as Prometheus reads it (a year is 365 days). */
export const promqlDurationMs = (duration: string): number =>
	Arr.reduce(
		Arr.fromIterable(Str.matchAll(DURATION_PART)(duration)),
		0,
		(total, [, count, unit]) => total + Number(count) * (UNIT_MS.get(unit ?? "") ?? 0),
	)

/** A token for code: whole, and a duration no wider than a query may read. */
const safeToken = (value: string): boolean =>
	SAFE_TOKEN.test(value) &&
	(!DURATION.test(value) || promqlDurationMs(value) <= MAX_PROMQL_READ_WINDOW_SECONDS * 1000)

/**
 * A value as it may appear in `context`, or undefined when it cannot appear there without
 * changing the query's structure (a quote in a raw string, an operator in code).
 */
const placed = (value: string, context: QuoteContext): string | undefined => {
	switch (context) {
		case '"':
		case "'":
			return promqlStringEscape(value, context)
		case "`":
			return Str.includes("`")(value) ? undefined : value
		case "code":
			return safeToken(value) ? value : undefined
	}
}

/** The query split into code and string-literal runs, quotes kept with the code around them. */
const quoteRuns = (
	query: string,
): ReadonlyArray<{ readonly text: string; readonly context: QuoteContext }> => {
	const runs: Array<{ text: string; context: QuoteContext }> = []
	let context: QuoteContext = "code"
	let current = ""
	for (let i = 0; i < query.length; i++) {
		const ch = query[i] ?? ""
		if (context === "code" && ch === "#") {
			// A comment runs to the end of the line; its quotes open no string.
			while (i < query.length && query[i] !== "\n") {
				current += query[i] ?? ""
				i += 1
			}
			i -= 1
			continue
		}
		if (context === "code") {
			current += ch
			if (ch === '"' || ch === "'" || ch === "`") {
				runs.push({ text: current, context })
				current = ""
				context = ch
			}
			continue
		}
		if (ch === "\\" && context !== "`") {
			current += ch + (query[i + 1] ?? "")
			i += 1
			continue
		}
		if (ch === context) {
			runs.push({ text: current, context })
			current = ch
			context = "code"
			continue
		}
		current += ch
	}
	runs.push({ text: current, context })
	return runs
}

/** Every variable name a PromQL query references, in any of the four syntaxes. */
export const collectPromqlVariableRefs = (query: string): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(Arr.fromIterable(Str.matchAll(PROMQL_VAR_REF)(query)), (match) => {
			const name = match[1] ?? match[3] ?? match[4]
			return name === undefined ? [] : [name]
		}),
	)

/**
 * Dashboard variables substituted into a PromQL query.
 *
 * A single value goes in as itself, regex-escaped inside a `=~` / `!~` matcher (or under
 * `:regex`) so it matches only itself; `:raw` keeps it a pattern. An "All" selection becomes an
 * escaped regex alternation of every option, `(a|b)`, as Grafana writes a multi-value variable.
 * A value is escaped for the string it sits in, and one that would change the query's structure
 * (a quote in a raw string, an operator outside a string) is not substituted. An unknown or
 * refused variable stays literal, so it matches nothing rather than everything.
 */
export function interpolatePromqlVariables(query: string, values: VariableValues): string {
	if (!Str.includes("$")(query) && !Str.includes("[[")(query)) return query
	const runs = quoteRuns(query)
	return Arr.join(
		Arr.map(runs, ({ text, context }, index) => {
			const inRegex =
				context !== "code" &&
				OPENS_REGEX_MATCHER.test(Str.replace(PROMQL_COMMENT, "")(runs[index - 1]?.text ?? ""))
			return replaceWith(
				text,
				PROMQL_VAR_REF,
				(
					match,
					braced: string | undefined,
					format: string | undefined,
					bracketed: string | undefined,
					bare: string | undefined,
				) => {
					// An own key only, so `$constructor` stays literal instead of reading Object's.
					const variable = Option.getOrUndefined(Rec.get(values, braced ?? bracketed ?? bare ?? ""))
					if (variable === undefined) return match
					if (variable.isAll) {
						if (context === "code") return match
						const options = Arr.map(variable.options, (option) =>
							placed(promqlRegexEscape(option), context),
						)
						if (options.length === 0) return ".*"
						if (Arr.some(options, (o) => o === undefined)) return match
						const escaped = Arr.filter(options, (o): o is string => o !== undefined)
						return escaped.length === 1 ? (escaped[0] ?? "") : `(${Arr.join(escaped, "|")})`
					}
					const escape = format === "regex" || (inRegex && format !== "raw")
					const value = escape ? promqlRegexEscape(variable.value) : variable.value
					return placed(value, context) ?? match
				},
			)
		}),
		"",
	)
}

/** Grafana's assumed scrape interval for `$__rate_interval` when the source names none. */
export const PROMQL_SCRAPE_INTERVAL_MS = 15_000

/** A duration as PromQL writes it: whole seconds as `Ns`, anything finer as `Nms`. */
export const formatPromqlDuration = (ms: number): string =>
	ms % 1000 === 0 ? `${ms / 1000}s` : `${Math.round(ms)}ms`

export interface PromqlBuiltinContext {
	readonly startMs: number
	readonly endMs: number
	readonly stepMs: number
}

// Longer names first in the alternation, so `$__interval_ms` never reads as `$__interval`.
const BUILTIN_REF =
	/\$\{__(rate_interval|interval_ms|interval|range_ms|range_s|range)\}|\$__(rate_interval|interval_ms|interval|range_ms|range_s|range)(?![A-Za-z0-9_])/g

/**
 * The time built-ins: `$__interval` (the step), `$__rate_interval` (Grafana's
 * max(4 * scrape interval, interval + scrape interval)), `$__range`, plus their `_ms` / `_s` forms.
 */
export function interpolatePromqlBuiltins(query: string, context: PromqlBuiltinContext): string {
	if (!Str.includes("$")(query)) return query
	const rangeMs = Math.max(0, context.endMs - context.startMs)
	const values = new Map([
		["interval", formatPromqlDuration(context.stepMs)],
		["interval_ms", String(Math.round(context.stepMs))],
		[
			"rate_interval",
			formatPromqlDuration(
				Math.max(4 * PROMQL_SCRAPE_INTERVAL_MS, context.stepMs + PROMQL_SCRAPE_INTERVAL_MS),
			),
		],
		["range", formatPromqlDuration(Math.round(rangeMs / 1000) * 1000)],
		["range_s", String(Math.round(rangeMs / 1000))],
		["range_ms", String(Math.round(rangeMs))],
	])
	// Built-ins sit in code (a range, a step); a string holds a dashboard value, which stays literal.
	return Arr.join(
		Arr.map(quoteRuns(query), ({ text, context }) =>
			context !== "code"
				? text
				: replaceWith(
						text,
						BUILTIN_REF,
						(match, braced: string | undefined, bare: string | undefined) =>
							values.get(braced ?? bare ?? "") ?? match,
					),
		),
		"",
	)
}
