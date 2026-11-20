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

/** A value as a double-quoted PromQL string. */
const quoted = (value: string): string =>
	`"${Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(value))}"`

export const discoveryKey = (request: DiscoveryRequest): string =>
	`${request.label ?? ""}|${request.match ?? ""}`

const selectorOf = (metric: string | null): string | undefined =>
	metric === null ? undefined : `{__name__=${quoted(metric)}}`

/** The read a context completes from, or null when the language alone answers it. */
export const discoveryRequestFor = (context: PromqlCompletionContext): DiscoveryRequest | null => {
	const metricMatch = (metric: string | null) => {
		const match = selectorOf(metric)
		return match === undefined ? {} : { match }
	}
	switch (context.kind) {
		case "expression":
			return { label: "__name__" }
		case "labelName":
			return metricMatch(context.metric)
		case "labelValue":
			return { label: context.label, ...metricMatch(context.metric) }
		default:
			return null
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
		if (name === needle) return []
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
	const request = discoveryRequestFor(context)
	const found =
		request === null ? [] : Option.getOrElse(Rec.get(discovery.entries, discoveryKey(request)), () => [])
	switch (context.kind) {
		case "expression":
			return ranked(
				[
					...named("metric", found),
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
				named(
					"label",
					Arr.filter(found, (name) => name !== "__name__"),
				),
				context.prefix,
			)
		case "labelValue":
			return ranked(
				Arr.map(found, (value) => ({
					label: value,
					insert: context.isQuoted ? value : quoted(value),
					kind: "value" as const,
				})),
				context.prefix,
			)
		case "duration":
			return ranked([...variablesOf(variables), ...named("duration", DURATIONS)], context.prefix)
		case "variable":
			return ranked(variablesOf(variables), context.prefix)
	}
}
