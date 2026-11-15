// Grafana-style template variables in a PromQL widget query. Pure.
//
// Dashboard variables (`$var`, `${var}`, `${var:regex}`, `[[var]]`) are filled by the
// widget planner; the built-ins (`$__interval`, `$__rate_interval`, `$__range`, ...) need
// the step, so the executor fills them once it has picked one.
import { Array as Arr, String as Str } from "effect"
import { replaceWith } from "@maple/strings"
import type { VariableValues } from "../dashboard-variables/interpolate"

// `${name:format}` and `${name}` before bare `$name`, so a branch consumes its braces.
const PROMQL_VAR_REF =
	/\$\{([A-Za-z][A-Za-z0-9_]*)(?::([A-Za-z]+))?\}|\[\[([A-Za-z][A-Za-z0-9_]*)\]\]|\$([A-Za-z][A-Za-z0-9_]*)/g

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/** A value escaped for a RE2 regex: what `=~` and `!~` matchers take. */
export const promqlRegexEscape = (value: string): string =>
	replaceWith(value, REGEX_SPECIALS, (match) => `\\${match}`)

/** A value escaped for the inside of a double-quoted PromQL string, so it cannot close the literal. */
export const promqlStringEscape = (value: string): string =>
	replaceWith(value, /[\\"]/g, (match) => `\\${match}`)

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
 * A single value goes in as itself; an "All" selection becomes a regex alternation of every
 * option, `(a|b)`, as Grafana writes a multi-value Prometheus variable. `:regex` escapes even a
 * single value. Every value is string-escaped so it cannot leave the literal it sits in. An
 * unknown variable stays literal, so the query fails to parse rather than matching everything.
 */
export function interpolatePromqlVariables(query: string, values: VariableValues): string {
	if (!Str.includes("$")(query) && !Str.includes("[[")(query)) return query
	return replaceWith(
		query,
		PROMQL_VAR_REF,
		(
			match,
			braced: string | undefined,
			format: string | undefined,
			bracketed: string | undefined,
			bare: string | undefined,
		) => {
			const variable = values[braced ?? bracketed ?? bare ?? ""]
			if (variable === undefined) return match
			if (variable.isAll) {
				const escaped = Arr.map(variable.options, (option) =>
					promqlStringEscape(promqlRegexEscape(option)),
				)
				if (escaped.length === 0) return ".*"
				return escaped.length === 1 ? (escaped[0] ?? "") : `(${Arr.join(escaped, "|")})`
			}
			const value = format === "regex" ? promqlRegexEscape(variable.value) : variable.value
			return promqlStringEscape(value)
		},
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
	return replaceWith(
		query,
		BUILTIN_REF,
		(match, braced: string | undefined, bare: string | undefined) =>
			values.get(braced ?? bare ?? "") ?? match,
	)
}
