import { replaceWith } from "@maple/strings"
import { Array as Arr, Option, Order, Record as Rec, Schema, String as Str } from "effect"
import { AGGREGATIONS, FUNCTION_ENTRIES, KEYWORDS } from "./promql-docs"
import type { PromqlCompletionContext } from "./promql-complete"

// What the PromQL editor offers at the caret, from the language and the org's discovered names.

/** One discovery read: label names (no `label`), or a label's values, for the series `match` picks. */
export type DiscoveryRequest = Readonly<{ label?: string; match?: string }>

/** Discovered names by request key, and the keys already asked for (once per editor session). */
export const PromqlDiscovery = Schema.Struct({
	entries: Schema.Record(Schema.String, Schema.Array(Schema.String)),
	requested: Schema.Array(Schema.String),
})
export type PromqlDiscovery = typeof PromqlDiscovery.Type

export const EMPTY_DISCOVERY: PromqlDiscovery = { entries: {}, requested: [] }

/** How many names one read returns; a full page means there may be more past it. */
export const DISCOVERY_PAGE = 500

/** A value as it goes inside a string with that quote, or null when a raw string cannot hold it. */
const escapedFor = (value: string, quote: string): string | null =>
	quote === "`"
		? Str.includes("`")(value)
			? null
			: value
		: replaceWith(value, quote === "'" ? /[\\'\n]/g : /[\\"\n]/g, (match) =>
				match === "\n" ? "\\n" : `\\${match}`,
			)

/** A value as a double-quoted PromQL string. */
const quoted = (value: string): string => `"${escapedFor(value, '"') ?? value}"`

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export const discoveryKey = (request: DiscoveryRequest): string =>
	`${request.label ?? ""}|${request.match ?? ""}`

const selectorOf = (metric: string | null): string | undefined =>
	metric === null ? undefined : `{__name__=${quoted(metric)}}`

const metricMatch = (metric: string | null): DiscoveryRequest => {
	const match = selectorOf(metric)
	return match === undefined ? {} : { match }
}

/**
 * The reads a context completes from (none when the language alone answers it). Metric names come
 * as one page; when that page is full, the typed prefix asks the server for the names it narrows to,
 * but only once typing has paused (`isSettled`), so a long name is not one read per keystroke.
 */
export const discoveryRequestsFor = (
	context: PromqlCompletionContext,
	discovery: PromqlDiscovery,
	isSettled = true,
): ReadonlyArray<DiscoveryRequest> => {
	switch (context.kind) {
		case "expression": {
			const page: DiscoveryRequest = { label: "__name__" }
			const listed = Option.getOrElse(Rec.get(discovery.entries, discoveryKey(page)), () => [])
			const prefix = context.prefix
			return !isSettled ||
				listed.length < DISCOVERY_PAGE ||
				prefix.length < 2 ||
				!METRIC_NAME.test(prefix)
				? [page]
				: [
						page,
						{
							label: "__name__",
							match: `{__name__=~${quoted(`${Str.replaceAll(".", "\\.")(prefix)}.*`)}}`,
						},
					]
		}
		case "labelName":
			return [metricMatch(context.metric)]
		case "labelValue":
			// The server reads values of identifier labels only; a quoted UTF-8 label completes nothing.
			return LABEL_NAME.test(context.label)
				? [{ label: context.label, ...metricMatch(context.metric) }]
				: []
		default:
			return []
	}
}

export const SuggestionKind = Schema.Literals([
	"metric",
	"function",
	"aggregation",
	"keyword",
	"label",
	"value",
	"variable",
	"duration",
])
export type SuggestionKind = typeof SuggestionKind.Type

/** A suggestion: what the list shows, what a pick writes over `[from, caret)`, and its signature and doc. */
export type Suggestion = Readonly<{
	label: string
	insert: string
	kind: SuggestionKind
	detail?: string
	doc?: string
}>

export const BUILTIN_VARIABLES: ReadonlyArray<readonly [name: string, doc: string]> = [
	["$__rate_interval", "The range rate() needs: at least four scrapes, and one step plus a scrape."],
	["$__interval", "The panel's step."],
	["$__range", "The dashboard's time range."],
]

const DURATIONS = ["1m", "5m", "15m", "1h"]
const MAX_SUGGESTIONS = 50

/** Names matching the typed prefix, those that start with it first; an empty prefix keeps them all. */
const ranked = (items: ReadonlyArray<Suggestion>, prefix: string): ReadonlyArray<Suggestion> => {
	const needle = Str.toLowerCase(prefix)
	const scored = Arr.flatMap(items, (item) => {
		const name = Str.toLowerCase(item.label)
		// What is typed already offers nothing, unless the pick adds to it (`rate` gives `rate(`).
		if (item.insert === prefix) return []
		const rank = Str.startsWith(needle)(name) ? 0 : Str.includes(needle)(name) ? 1 : -1
		return rank === -1 ? [] : [[rank, item] as const]
	})
	return Arr.take(
		Arr.map(
			Arr.sort(
				scored,
				Order.mapInput(Order.Number, ([rank]: readonly [number, Suggestion]) => rank),
			),
			([, item]) => item,
		),
		MAX_SUGGESTIONS,
	)
}

const named = (kind: SuggestionKind, names: ReadonlyArray<string>): ReadonlyArray<Suggestion> =>
	Arr.map(names, (name) => ({ label: name, insert: name, kind }))

/** A discovered name as PromQL writes it: bare when it is an identifier, else quoted (UTF-8 names). */
const metricInsert = (name: string): string => (METRIC_NAME.test(name) ? name : `{${quoted(name)}}`)
const labelInsert = (name: string): string => (LABEL_NAME.test(name) ? name : quoted(name))

const variablesOf = (variables: ReadonlyArray<string>): ReadonlyArray<Suggestion> => [
	...Arr.map(BUILTIN_VARIABLES, ([name, doc]) => ({
		label: name,
		insert: name,
		kind: "variable" as const,
		doc,
	})),
	...Arr.map(variables, (name) => ({
		label: `$${name}`,
		insert: `$${name}`,
		kind: "variable" as const,
		doc: "Dashboard variable: expands to the selected value.",
	})),
]

/** The suggestions for a context, from the discovered names and the dashboard's variable names. */
export const suggestionsFor = (
	context: PromqlCompletionContext,
	discovery: PromqlDiscovery,
	variables: ReadonlyArray<string>,
): ReadonlyArray<Suggestion> => {
	const found = Arr.dedupe(
		Arr.flatMap(discoveryRequestsFor(context, discovery), (request) =>
			Option.getOrElse(
				Rec.get(discovery.entries, discoveryKey(request)),
				(): ReadonlyArray<string> => [],
			),
		),
	)
	switch (context.kind) {
		case "expression":
			return ranked(
				[
					...Arr.map(found, (name) => ({
						label: name,
						insert: metricInsert(name),
						kind: "metric" as const,
					})),
					...Arr.map(AGGREGATIONS, ([name, detail, doc]) => ({
						label: name,
						insert: name,
						kind: "aggregation" as const,
						detail,
						doc,
					})),
					...Arr.map(FUNCTION_ENTRIES, ([name, detail, doc]) => ({
						label: name,
						insert: `${name}(`,
						kind: "function" as const,
						detail,
						doc,
					})),
				],
				context.prefix,
			)
		case "operator":
			return ranked(
				Arr.map(KEYWORDS, ([name, doc]) => ({
					label: name,
					insert: name,
					kind: "keyword" as const,
					doc,
				})),
				context.prefix,
			)
		case "labelName":
			return ranked(
				Arr.map(
					Arr.filter(found, (name) => name !== "__name__"),
					(name) => ({ label: name, insert: labelInsert(name), kind: "label" as const }),
				),
				context.prefix,
			)
		case "labelValue":
			return ranked(
				Arr.flatMap(found, (value) => {
					const insert = context.quote === null ? quoted(value) : escapedFor(value, context.quote)
					return insert === null ? [] : [{ label: value, insert, kind: "value" as const }]
				}),
				context.prefix,
			)
		case "duration":
			return ranked([...variablesOf(variables), ...named("duration", DURATIONS)], context.prefix)
		case "variable":
			return ranked(variablesOf(variables), context.prefix)
	}
}
