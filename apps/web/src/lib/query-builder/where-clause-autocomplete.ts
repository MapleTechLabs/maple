import {
	QUERY_BUILDER_METRIC_TYPES,
	type QueryBuilderDataSource,
	type QueryBuilderMetricType,
} from "@maple/query-engine/query-builder"
import { type Operator, normalizeKey as sharedNormalizeKey } from "@maple/domain/where-clause"
import { FUNNEL_POPULATION_FILTER_FIELDS, type FunnelPopulationFilterField } from "@maple/query-model"
import { productEventsFilterField, productEventsFilterKey } from "./funnel-filters"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"

type WhereClauseAutocompleteContext = "key" | "operator" | "value" | "conjunction"

/**
 * Which vocabulary the editor completes. `product_events` is the funnel
 * widget's population filter (session dimensions); `product_event_attributes`
 * is a funnel step's attribute filter, whose keys are the customer's own and
 * are not suggested. Both take `=` only — the funnel query runs nothing else.
 */
export type WhereClauseAutocompleteScope =
	| "default"
	| "trace_search"
	| "product_events"
	| "product_event_attributes"

const PRODUCT_EVENT_SCOPES: ReadonlyArray<WhereClauseAutocompleteScope> = [
	"product_events",
	"product_event_attributes",
]

export interface WhereClauseAutocompleteValues {
	services?: string[]
	spanNames?: string[]
	environments?: string[]
	commitShas?: string[]
	severities?: string[]
	httpMethods?: string[]
	httpStatusCodes?: string[]
	metricTypes?: QueryBuilderMetricType[]
	attributeKeys?: string[]
	attributeValues?: string[]
	resourceAttributeKeys?: string[]
	resourceAttributeValues?: string[]
	/** Dashboard variable names — suggested as `$name` in every value position. */
	variables?: string[]
	/** Per-field values for the session dimensions (the web-analytics facets). */
	productEventFacets?: Partial<Record<FunnelPopulationFilterField, string[]>>
	/** `product_events` source: the event names, hosts and page paths seen in the window. */
	eventNames?: string[]
	hosts?: string[]
	pagePaths?: string[]
}

export interface WhereClauseAutocompleteSuggestion {
	id: string
	kind: WhereClauseAutocompleteContext
	label: string
	insertText: string
	description?: string
}

export interface WhereClauseAutocompleteResult {
	context: WhereClauseAutocompleteContext
	query: string
	key: string | null
	replaceStart: number
	replaceEnd: number
	suggestions: WhereClauseAutocompleteSuggestion[]
}

interface WhereClauseAutocompleteInput {
	expression: string
	cursor: number
	dataSource: QueryBuilderDataSource
	values?: WhereClauseAutocompleteValues
	scope?: WhereClauseAutocompleteScope
	maxSuggestions?: number
}

interface ApplyWhereClauseSuggestionInput {
	expression: string
	context: WhereClauseAutocompleteContext
	replaceStart: number
	replaceEnd: number
	suggestion: WhereClauseAutocompleteSuggestion
}

interface ParsedWhereClauseContext {
	context: WhereClauseAutocompleteContext
	key: string | null
	query: string
	replaceStart: number
	replaceEnd: number
}

interface KeyDefinition {
	label: string
	insertText: string
	description?: string
}

const KEY_DEFINITIONS: Record<QueryBuilderDataSource, KeyDefinition[]> = {
	traces: [
		{
			label: "service.name",
			insertText: "service.name",
			description: "Filter by service",
		},
		{
			label: "span.name",
			insertText: "span.name",
			description: "Filter by span name",
		},
		{
			label: "deployment.environment",
			insertText: "deployment.environment",
			description: "Filter by deployment environment",
		},
		{
			label: "vcs.ref.head.revision",
			insertText: "vcs.ref.head.revision",
			description: "Filter by commit sha",
		},
		{
			label: "root_only",
			insertText: "root_only",
			description: "true or false",
		},
		{
			label: "has_error",
			insertText: "has_error",
			description: "Filter to error spans only (true or false)",
		},
		{
			label: "attr.<key>",
			insertText: "attr.",
			description: "Filter by a single span attribute",
		},
		{
			label: "resource.<key>",
			insertText: "resource.",
			description: "Filter by a single resource attribute",
		},
	],
	logs: [
		{
			label: "service.name",
			insertText: "service.name",
			description: "Filter by service",
		},
		{
			label: "severity",
			insertText: "severity",
			description: "Filter by severity",
		},
		{
			label: "attr.<key>",
			insertText: "attr.",
			description: "Filter by a log attribute",
		},
		{
			label: "resource.<key>",
			insertText: "resource.",
			description: "Filter by a resource attribute",
		},
	],
	product_events: [
		{
			label: "event.name",
			insertText: "event.name",
			description: "Event name, comma-separated for several",
		},
		{ label: "event.kind", insertText: "event.kind", description: "navigation | custom | screen" },
		{ label: "source", insertText: "source", description: "browser | server | mobile | trace" },
		{ label: "host", insertText: "host", description: "Site host the event fired on" },
		{ label: "page.path", insertText: "page.path", description: "Page path the event fired on" },
		{
			label: "service.name",
			insertText: "service.name",
			description: "Emitting service (server events)",
		},
		{ label: "user.id", insertText: "user.id", description: "Identified user" },
		{ label: "group.id", insertText: "group.id", description: "Group / organization id" },
		{ label: "attr.<key>", insertText: "attr.", description: "Filter by a track() prop" },
		{ label: "country", insertText: "country", description: "Session country code, e.g. DE" },
		{ label: "referrer.host", insertText: "referrer.host", description: "Session referrer host" },
		{ label: "utm.source", insertText: "utm.source", description: "Session utm_source" },
		{ label: "utm.medium", insertText: "utm.medium", description: "Session utm_medium" },
		{ label: "utm.campaign", insertText: "utm.campaign", description: "Session utm_campaign" },
		{ label: "device.type", insertText: "device.type", description: "desktop | mobile | tablet" },
		{ label: "browser", insertText: "browser", description: "Session browser name" },
		{ label: "os", insertText: "os", description: "Session operating system" },
		{ label: "visitor.type", insertText: "visitor.type", description: "new | returning" },
	],
	metrics: [
		{
			label: "service.name",
			insertText: "service.name",
			description: "Filter by service",
		},
		{
			label: "metric.type",
			insertText: "metric.type",
			description: "sum | gauge | histogram | exponential_histogram",
		},
		{
			label: "attr.<key>",
			insertText: "attr.",
			description: "Filter by a metric attribute",
		},
	],
} satisfies Record<QueryBuilderDataSource, KeyDefinition[]>

const PRODUCT_EVENTS_KEY_DESCRIPTIONS = {
	host: "Site the session was on",
	pagePath: "Sessions that viewed this page",
	referrerHost: "Referrer host, e.g. news.ycombinator.com",
	country: "Country code, e.g. DE",
	deviceType: "desktop | mobile | tablet",
	browserName: "Browser name",
	osName: "Operating system",
	language: "Browser language",
	utmSource: "utm_source of the session",
	utmMedium: "utm_medium of the session",
	utmCampaign: "utm_campaign of the session",
	visitorType: "new | returning",
} satisfies Record<FunnelPopulationFilterField, string>

/** The funnel population filter's keys — one per `FunnelPopulationFilters` field, canonical spelling. */
const PRODUCT_EVENTS_KEY_DEFINITIONS: KeyDefinition[] = Arr.map(FUNNEL_POPULATION_FILTER_FIELDS, (field) => ({
	label: productEventsFilterKey(field),
	insertText: productEventsFilterKey(field),
	description: PRODUCT_EVENTS_KEY_DESCRIPTIONS[field],
}))

const TRACE_SEARCH_KEY_DEFINITIONS: KeyDefinition[] = [
	{
		label: "service.name",
		insertText: "service.name",
		description: "Filter by service",
	},
	{
		label: "span.name",
		insertText: "span.name",
		description: "Filter by root span name",
	},
	{
		label: "deployment.environment",
		insertText: "deployment.environment",
		description: "Filter by deployment environment",
	},
	{
		label: "service.namespace",
		insertText: "service.namespace",
		description: "Filter by service namespace",
	},
	{
		label: "http.method",
		insertText: "http.method",
		description: "Filter by HTTP method",
	},
	{
		label: "http.status_code",
		insertText: "http.status_code",
		description: "Filter by HTTP status code",
	},
	{
		label: "has_error",
		insertText: "has_error",
		description: "true or false",
	},
	{
		label: "root_only",
		insertText: "root_only",
		description: "true or false",
	},
	{
		label: "min_duration_ms",
		insertText: "min_duration_ms",
		description: "Minimum duration in milliseconds",
	},
	{
		label: "max_duration_ms",
		insertText: "max_duration_ms",
		description: "Maximum duration in milliseconds",
	},
	{
		label: "attr.<key>",
		insertText: "attr.",
		description: "Filter by a single span attribute",
	},
	{
		label: "resource.<key>",
		insertText: "resource.",
		description: "Filter by a single resource attribute",
	},
]

function isSpace(char: string | undefined): boolean {
	return char == null || /\s/.test(char)
}

function clampCursor(expression: string, cursor: number): number {
	if (!Number.isFinite(cursor)) {
		return expression.length
	}

	return Math.min(Math.max(Math.trunc(cursor), 0), expression.length)
}

function findLastConjunctionBoundary(expression: string, cursor: number): number {
	let quote: '"' | "'" | null = null
	let boundary = 0

	for (let index = 0; index < cursor; index += 1) {
		const char = expression[index]

		if (quote) {
			if (char === quote && expression[index - 1] !== "\\") {
				quote = null
			}
			continue
		}

		if (char === '"' || char === "'") {
			quote = char
			continue
		}

		if (Str.toLowerCase(Str.slice(index, index + 3)(expression)) !== "and") {
			continue
		}

		const before = index === 0 ? undefined : expression[index - 1]
		const after = expression[index + 3]
		if (!isSpace(before) || !isSpace(after)) {
			continue
		}

		if (index + 3 <= cursor) {
			boundary = index + 3
			index += 2
		}
	}

	return boundary
}

interface OperatorMatch {
	position: number
	length: number
	operator: Operator
}

function findFirstOperator(segment: string): OperatorMatch | null {
	let quote: '"' | "'" | null = null

	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index]

		if (quote) {
			if (char === quote && segment[index - 1] !== "\\") {
				quote = null
			}
			continue
		}

		if (char === '"' || char === "'") {
			quote = char
			continue
		}

		if (char === "!") {
			if (segment[index + 1] === "=") {
				return { position: index, length: 2, operator: "!=" }
			}
			// Allow "!contains" / "! contains" — find the keyword skipping optional whitespace
			let lookahead = index + 1
			while (lookahead < segment.length && isSpace(segment[lookahead])) lookahead += 1
			if (Str.toLowerCase(Str.slice(lookahead, lookahead + 8)(segment)) === "contains") {
				const after = segment[lookahead + 8]
				if (isSpace(after) || after === undefined) {
					return { position: index, length: lookahead + 8 - index, operator: "!contains" }
				}
			}
			if (Str.toLowerCase(Str.slice(lookahead, lookahead + 6)(segment)) === "exists") {
				const after = segment[lookahead + 6]
				if (isSpace(after) || after === undefined) {
					return { position: index, length: lookahead + 6 - index, operator: "!exists" }
				}
			}
			// Lone "!" with no recognized follower — skip and continue scanning
		}

		if (char === "<") {
			if (segment[index + 1] === "=") {
				return { position: index, length: 2, operator: "<=" }
			}
			return { position: index, length: 1, operator: "<" }
		}

		if (char === ">") {
			if (segment[index + 1] === "=") {
				return { position: index, length: 2, operator: ">=" }
			}
			return { position: index, length: 1, operator: ">" }
		}

		if (char === "=") {
			return { position: index, length: 1, operator: "=" }
		}

		if (Str.toLowerCase(Str.slice(index, index + 8)(segment)) === "contains") {
			const before = index === 0 ? undefined : segment[index - 1]
			const after = segment[index + 8]
			if (isSpace(before) && (isSpace(after) || after === undefined)) {
				return { position: index, length: 8, operator: "contains" }
			}
		}

		if (Str.toLowerCase(Str.slice(index, index + 6)(segment)) === "exists") {
			const before = index === 0 ? undefined : segment[index - 1]
			const after = segment[index + 6]
			if (isSpace(before) && (isSpace(after) || after === undefined)) {
				return { position: index, length: 6, operator: "exists" }
			}
		}
	}

	return null
}

function findClosingQuote(input: string, quote: '"' | "'"): number {
	for (let index = 1; index < input.length; index += 1) {
		if (input[index] === quote && input[index - 1] !== "\\") {
			return index
		}
	}

	return -1
}

function parseWhereClauseContext(expression: string, cursor: number): ParsedWhereClauseContext {
	const cursorPosition = clampCursor(expression, cursor)
	const segmentStart = findLastConjunctionBoundary(expression, cursorPosition)
	const segment = Str.slice(segmentStart, cursorPosition)(expression)
	const leadingWhitespace = segment.length - Str.trimStart(segment).length
	const trimmedSegment = Str.slice(leadingWhitespace)(segment)

	if (!trimmedSegment) {
		return {
			context: "key",
			query: "",
			key: null,
			replaceStart: cursorPosition,
			replaceEnd: cursorPosition,
		}
	}

	const operatorMatch = findFirstOperator(trimmedSegment)
	if (!operatorMatch) {
		const keyMatch = Str.match(/^([^\s=]+)(\s*)(.*)$/)(trimmedSegment)

		if (Option.isNone(keyMatch)) {
			const query = Str.trim(trimmedSegment)
			return {
				context: "key",
				query,
				key: null,
				replaceStart: cursorPosition - query.length,
				replaceEnd: cursorPosition,
			}
		}

		const keyPattern = keyMatch.value
		const [, keyToken = "", keyGap = "", operatorTail = ""] = keyPattern
		const keyStart = segmentStart + leadingWhitespace

		if (!keyGap && operatorTail.length === 0) {
			return {
				context: "key",
				query: keyToken,
				key: null,
				replaceStart: keyStart,
				replaceEnd: cursorPosition,
			}
		}

		const operatorQuery = Str.trimStart(operatorTail)
		const operatorLeadingWhitespace = operatorTail.length - operatorQuery.length

		return {
			context: "operator",
			query: operatorQuery,
			key: keyToken,
			replaceStart: keyStart + keyToken.length + keyGap.length + operatorLeadingWhitespace,
			replaceEnd: cursorPosition,
		}
	}

	const keyToken = Str.trim(Str.slice(0, operatorMatch.position)(trimmedSegment))
	if (!keyToken) {
		return {
			context: "key",
			query: "",
			key: null,
			replaceStart: cursorPosition,
			replaceEnd: cursorPosition,
		}
	}

	// EXISTS / !EXISTS takes no value — go straight to conjunction context
	if (operatorMatch.operator === "exists" || operatorMatch.operator === "!exists") {
		const tail = Str.slice(operatorMatch.position + operatorMatch.length)(trimmedSegment)
		const tailTrimmed = Str.trimStart(tail)
		return {
			context: "conjunction",
			query: tailTrimmed,
			key: keyToken,
			replaceStart: cursorPosition - tailTrimmed.length,
			replaceEnd: cursorPosition,
		}
	}

	const valueTail = Str.slice(operatorMatch.position + operatorMatch.length)(trimmedSegment)
	const valueTailLeadingWhitespace = valueTail.length - Str.trimStart(valueTail).length
	const trimmedValueTail = Str.slice(valueTailLeadingWhitespace)(valueTail)
	const valueStart =
		segmentStart +
		leadingWhitespace +
		operatorMatch.position +
		operatorMatch.length +
		valueTailLeadingWhitespace

	if (!trimmedValueTail) {
		return {
			context: "value",
			query: "",
			key: keyToken,
			replaceStart: cursorPosition,
			replaceEnd: cursorPosition,
		}
	}

	const firstValueChar = trimmedValueTail[0]
	if (firstValueChar === '"' || firstValueChar === "'") {
		const closingQuote = findClosingQuote(trimmedValueTail, firstValueChar)

		if (closingQuote === -1) {
			return {
				context: "value",
				query: Str.slice(1)(trimmedValueTail),
				key: keyToken,
				replaceStart: valueStart + 1,
				replaceEnd: cursorPosition,
			}
		}

		const trailing = Str.slice(closingQuote + 1)(trimmedValueTail)
		if (!Str.trim(trailing)) {
			return {
				context: "conjunction",
				query: "",
				key: keyToken,
				replaceStart: cursorPosition,
				replaceEnd: cursorPosition,
			}
		}

		const trailingLeadingWhitespace = trailing.length - Str.trimStart(trailing).length

		return {
			context: "conjunction",
			query: Str.slice(trailingLeadingWhitespace)(trailing),
			key: keyToken,
			replaceStart: valueStart + closingQuote + 1 + trailingLeadingWhitespace,
			replaceEnd: cursorPosition,
		}
	}

	const unquotedMatch = Str.match(/^(\S+)(.*)$/)(trimmedValueTail)
	if (Option.isNone(unquotedMatch)) {
		return {
			context: "value",
			query: "",
			key: keyToken,
			replaceStart: cursorPosition,
			replaceEnd: cursorPosition,
		}
	}

	const unquotedValue = unquotedMatch.value
	const [, valueToken = "", trailing] = unquotedValue

	if (!trailing) {
		return {
			context: "value",
			query: valueToken,
			key: keyToken,
			replaceStart: valueStart,
			replaceEnd: cursorPosition,
		}
	}

	if (!Str.trim(trailing)) {
		return {
			context: "conjunction",
			query: "",
			key: keyToken,
			replaceStart: cursorPosition,
			replaceEnd: cursorPosition,
		}
	}

	const trailingLeadingWhitespace = trailing.length - Str.trimStart(trailing).length

	return {
		context: "conjunction",
		query: Str.slice(trailingLeadingWhitespace)(trailing),
		key: keyToken,
		replaceStart: valueStart + valueToken.length + trailingLeadingWhitespace,
		replaceEnd: cursorPosition,
	}
}

function toSuggestion(
	suggestion: Omit<WhereClauseAutocompleteSuggestion, "kind">,
	kind: WhereClauseAutocompleteContext,
): WhereClauseAutocompleteSuggestion {
	return {
		kind,
		...suggestion,
	}
}

function normalizeKey(input: string | null): string {
	if (!input) {
		return ""
	}

	const normalized = sharedNormalizeKey(input)

	// Autocomplete-specific: collapse attr.* and resource.* prefixes
	// into wildcard keys for suggestion matching
	if (Str.startsWith("attr.")(normalized) && normalized !== "attr.") {
		return "attr.*"
	}

	if (Str.startsWith("resource.")(normalized) && normalized !== "resource.") {
		return "resource.*"
	}

	return normalized
}

function filterAndRankSuggestions(
	suggestions: WhereClauseAutocompleteSuggestion[],
	query: string,
	maxSuggestions: number,
): WhereClauseAutocompleteSuggestion[] {
	const normalizedQuery = Str.toLowerCase(Str.trim(query))

	const ranked = Arr.filter(
		Arr.map(suggestions, (suggestion, index) => {
			if (!normalizedQuery) {
				return {
					index,
					score: 0,
					suggestion,
				}
			}

			const normalizedLabel = Str.toLowerCase(suggestion.label)
			const normalizedInsert = Str.toLowerCase(suggestion.insertText)

			if (
				Str.startsWith(normalizedQuery)(normalizedLabel) ||
				Str.startsWith(normalizedQuery)(normalizedInsert)
			) {
				return {
					index,
					score: 0,
					suggestion,
				}
			}

			if (
				Str.includes(normalizedQuery)(normalizedLabel) ||
				Str.includes(normalizedQuery)(normalizedInsert)
			) {
				return {
					index,
					score: 1,
					suggestion,
				}
			}

			return {
				index,
				score: 99,
				suggestion,
			}
		}),
		(entry) => entry.score < 99,
	).sort((left, right) => {
		if (left.score !== right.score) {
			return left.score - right.score
		}

		return left.index - right.index
	})

	return Arr.map(ranked.slice(0, maxSuggestions), (entry) => entry.suggestion)
}

function uniqueValues(values: string[]): string[] {
	const seen = new Set<string>()
	const result: string[] = []

	for (const value of values) {
		const next = Str.trim(value)
		if (!next || seen.has(next)) {
			continue
		}

		seen.add(next)
		result.push(next)
	}

	return result
}

function toStringValueSuggestion(value: string, idPrefix: string): WhereClauseAutocompleteSuggestion {
	return {
		id: `${idPrefix}:${value}`,
		kind: "value",
		label: value,
		insertText: `"${Str.replace(/"/g, '\\\"')(Str.replace(/\\/g, "\\\\")(value))}"`,
	}
}

// Dashboard variables are valid in ANY value position — a variable-driven
// filter is the whole point of defining one — so they lead the suggestion
// list for every key. Quoted, matching the documented `key = "$name"` usage.
function buildVariableSuggestions(
	values: WhereClauseAutocompleteValues | undefined,
): WhereClauseAutocompleteSuggestion[] {
	return Arr.map(uniqueValues(values?.variables ?? []), (name) => ({
		id: `variable:${name}`,
		kind: "value",
		label: `$${name}`,
		insertText: `"$${name}"`,
		description: "Dashboard variable",
	}))
}

const PRODUCT_EVENT_KINDS = ["navigation", "custom", "screen"]
const PRODUCT_EVENT_SOURCES = ["browser", "server", "mobile", "trace"]

/** Values for the `product_events` source's own keys; `undefined` when the key is not one of them. */
function buildProductEventValueSuggestions(
	normalizedKey: string,
	values: WhereClauseAutocompleteValues | undefined,
): WhereClauseAutocompleteSuggestion[] | undefined {
	const fixed = {
		"event.name": uniqueValues(values?.eventNames ?? []),
		event: uniqueValues(values?.eventNames ?? []),
		"event.kind": PRODUCT_EVENT_KINDS,
		kind: PRODUCT_EVENT_KINDS,
		source: PRODUCT_EVENT_SOURCES,
		host: uniqueValues(values?.hosts ?? []),
		"page.path": uniqueValues(values?.pagePaths ?? []),
		path: uniqueValues(values?.pagePaths ?? []),
		"service.name": uniqueValues(values?.services ?? []),
	} satisfies Record<string, string[]>
	const own = Rec.get<string, string[]>(fixed, normalizedKey)
	if (Option.isSome(own)) {
		return Arr.map(own.value, (value) => toStringValueSuggestion(value, normalizedKey))
	}

	const field = productEventsFilterField(normalizedKey)
	if (field === undefined) return undefined
	if (field === "visitorType") {
		return Arr.map(["new", "returning"], (value) => toStringValueSuggestion(value, "visitor_type"))
	}
	return Arr.map(uniqueValues(values?.productEventFacets?.[field] ?? []), (value) =>
		toStringValueSuggestion(value, normalizedKey),
	)
}

function buildValueSuggestions(
	key: string | null,
	dataSource: QueryBuilderDataSource,
	values: WhereClauseAutocompleteValues | undefined,
	scope: WhereClauseAutocompleteScope,
): WhereClauseAutocompleteSuggestion[] {
	const normalizedKey = normalizeKey(key)

	if (scope === "product_event_attributes") return []
	if (scope === "product_events") {
		const field = productEventsFilterField(normalizedKey)
		if (field === undefined) return []
		if (field === "visitorType") {
			return Arr.map(["new", "returning"], (value) => toStringValueSuggestion(value, "visitor_type"))
		}
		return Arr.map(uniqueValues(values?.productEventFacets?.[field] ?? []), (value) =>
			toStringValueSuggestion(value, normalizedKey),
		)
	}

	if (dataSource === "product_events") {
		const eventValues = buildProductEventValueSuggestions(normalizedKey, values)
		if (eventValues !== undefined) return eventValues
	}

	if (normalizedKey === "root_only") {
		return [
			{
				id: "value:true",
				kind: "value",
				label: "true",
				insertText: "true",
			},
			{
				id: "value:false",
				kind: "value",
				label: "false",
				insertText: "false",
			},
		]
	}

	if (normalizedKey === "has_error") {
		return [
			{
				id: "value:has_error:true",
				kind: "value",
				label: "true",
				insertText: "true",
			},
			{
				id: "value:has_error:false",
				kind: "value",
				label: "false",
				insertText: "false",
			},
		]
	}

	if (normalizedKey === "metric.type") {
		const metricTypes =
			values?.metricTypes && values.metricTypes.length > 0
				? values.metricTypes
				: [...QUERY_BUILDER_METRIC_TYPES]

		return Arr.map(metricTypes, (type) => toStringValueSuggestion(type, "metricType"))
	}

	const mappedValues: Record<string, string[]> = {
		"service.name": uniqueValues(values?.services ?? []),
		"span.name": uniqueValues(values?.spanNames ?? []),
		"deployment.environment": uniqueValues(values?.environments ?? []),
		"vcs.ref.head.revision": uniqueValues(values?.commitShas ?? []),
		severity: uniqueValues(values?.severities ?? []),
		...(scope === "trace_search"
			? {
					"http.method": uniqueValues(values?.httpMethods ?? []),
					"http.status_code": uniqueValues(values?.httpStatusCodes ?? []),
				}
			: undefined),
	} satisfies Record<string, string[]>

	const explicit = mappedValues[normalizedKey]
	if (explicit !== undefined) {
		return Arr.map(explicit, (value) => toStringValueSuggestion(value, normalizedKey))
	}

	if (normalizedKey === "" && dataSource === "metrics") {
		return Arr.map([...QUERY_BUILDER_METRIC_TYPES], (type) => toStringValueSuggestion(type, "metricType"))
	}

	if (normalizedKey === "attr.*" && values?.attributeValues) {
		return Arr.map(uniqueValues(values.attributeValues), (value) =>
			toStringValueSuggestion(value, "attr"),
		)
	}

	if (normalizedKey === "resource.*" && values?.resourceAttributeValues) {
		return Arr.map(uniqueValues(values.resourceAttributeValues), (value) =>
			toStringValueSuggestion(value, "resource"),
		)
	}

	return []
}

const NOISY_ATTR_PREFIXES = ["http.request.header.", "http.response.header."]

function isNoisyAttributeKey(key: string): boolean {
	return Arr.some(NOISY_ATTR_PREFIXES, (prefix) => Str.startsWith(prefix)(key))
}

function buildAttributeKeySuggestions(attributeKeys: string[]): WhereClauseAutocompleteSuggestion[] {
	const clean: WhereClauseAutocompleteSuggestion[] = []
	const noisy: WhereClauseAutocompleteSuggestion[] = []

	for (const key of attributeKeys) {
		const suggestion: WhereClauseAutocompleteSuggestion = {
			id: `key:attr.${key}`,
			kind: "key",
			label: `attr.${key}`,
			insertText: `attr.${key}`,
			description: "Span attribute",
		}

		if (isNoisyAttributeKey(key)) {
			noisy.push(suggestion)
		} else {
			clean.push(suggestion)
		}
	}

	return [...clean, ...noisy]
}

function buildResourceAttributeKeySuggestions(attributeKeys: string[]): WhereClauseAutocompleteSuggestion[] {
	return Arr.map(attributeKeys, (key) => ({
		id: `key:resource.${key}`,
		kind: "key" as const,
		label: `resource.${key}`,
		insertText: `resource.${key}`,
		description: "Resource attribute",
	}))
}

function buildSuggestions(
	parsed: ParsedWhereClauseContext,
	dataSource: QueryBuilderDataSource,
	values: WhereClauseAutocompleteValues | undefined,
	scope: WhereClauseAutocompleteScope,
	maxSuggestions: number,
): WhereClauseAutocompleteSuggestion[] {
	if (parsed.context === "key") {
		const query = Str.toLowerCase(parsed.query)

		// When typing attr., show dynamic attribute keys instead of static definitions
		if (
			!PRODUCT_EVENT_SCOPES.includes(scope) &&
			Str.startsWith("attr.")(query) &&
			values?.attributeKeys &&
			values.attributeKeys.length > 0
		) {
			const attrSuggestions = buildAttributeKeySuggestions(values.attributeKeys)
			return filterAndRankSuggestions(attrSuggestions, query, maxSuggestions)
		}

		// When typing resource., show dynamic resource attribute keys
		if (
			!PRODUCT_EVENT_SCOPES.includes(scope) &&
			Str.startsWith("resource.")(query) &&
			values?.resourceAttributeKeys &&
			values.resourceAttributeKeys.length > 0
		) {
			const resourceSuggestions = buildResourceAttributeKeySuggestions(values.resourceAttributeKeys)
			return filterAndRankSuggestions(resourceSuggestions, query, maxSuggestions)
		}

		const keyDefinitions =
			scope === "product_events"
				? PRODUCT_EVENTS_KEY_DEFINITIONS
				: scope === "product_event_attributes"
					? []
					: scope === "trace_search" && dataSource === "traces"
						? TRACE_SEARCH_KEY_DEFINITIONS
						: KEY_DEFINITIONS[dataSource]

		const keySuggestions = Arr.map(keyDefinitions, (keyDef) =>
			toSuggestion(
				{
					id: `key:${keyDef.insertText}`,
					label: keyDef.label,
					insertText: keyDef.insertText,
					description: keyDef.description,
				},
				"key",
			),
		)

		return filterAndRankSuggestions(keySuggestions, parsed.query, maxSuggestions)
	}

	if (parsed.context === "operator") {
		const operatorSuggestions: WhereClauseAutocompleteSuggestion[] = PRODUCT_EVENT_SCOPES.includes(scope)
			? [
					{
						id: "operator:equal",
						kind: "operator",
						label: "=",
						insertText: "=",
						description: "Exact match",
					},
				]
			: [
					{
						id: "operator:equal",
						kind: "operator",
						label: "=",
						insertText: "=",
						description: "Exact match",
					},
					{
						id: "operator:not-equal",
						kind: "operator",
						label: "!=",
						insertText: "!=",
						description: "Not equal",
					},
					{
						id: "operator:gt",
						kind: "operator",
						label: ">",
						insertText: ">",
						description: "Greater than",
					},
					{
						id: "operator:lt",
						kind: "operator",
						label: "<",
						insertText: "<",
						description: "Less than",
					},
					{
						id: "operator:gte",
						kind: "operator",
						label: ">=",
						insertText: ">=",
						description: "Greater than or equal",
					},
					{
						id: "operator:lte",
						kind: "operator",
						label: "<=",
						insertText: "<=",
						description: "Less than or equal",
					},
					{
						id: "operator:contains",
						kind: "operator",
						label: "contains",
						insertText: "contains",
						description: "Substring match",
					},
					{
						id: "operator:not-contains",
						kind: "operator",
						label: "!contains",
						insertText: "!contains",
						description: "Substring does not match",
					},
					{
						id: "operator:exists",
						kind: "operator",
						label: "exists",
						insertText: "exists",
						description: "Key exists",
					},
					{
						id: "operator:not-exists",
						kind: "operator",
						label: "!exists",
						insertText: "!exists",
						description: "Key does not exist",
					},
				]

		return filterAndRankSuggestions(operatorSuggestions, parsed.query, maxSuggestions)
	}

	if (parsed.context === "value") {
		const valueSuggestions = [
			...buildVariableSuggestions(values),
			...buildValueSuggestions(parsed.key, dataSource, values, scope),
		]
		return filterAndRankSuggestions(valueSuggestions, parsed.query, maxSuggestions)
	}

	const conjunctionSuggestions: WhereClauseAutocompleteSuggestion[] = [
		{
			id: "conjunction:and",
			kind: "conjunction",
			label: "AND",
			insertText: "AND",
			description: "Add another clause",
		},
	]

	return filterAndRankSuggestions(conjunctionSuggestions, parsed.query, maxSuggestions)
}

export function getWhereClauseAutocomplete({
	expression,
	cursor,
	dataSource,
	values,
	scope = "default",
	maxSuggestions = 8,
}: WhereClauseAutocompleteInput): WhereClauseAutocompleteResult {
	const parsed = parseWhereClauseContext(expression, cursor)
	const suggestions = buildSuggestions(parsed, dataSource, values, scope, maxSuggestions)

	return {
		context: parsed.context,
		query: parsed.query,
		key: parsed.key,
		replaceStart: parsed.replaceStart,
		replaceEnd: parsed.replaceEnd,
		suggestions,
	}
}

function clampRange(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max))
}

export function applyWhereClauseSuggestion({
	expression,
	context,
	replaceStart,
	replaceEnd,
	suggestion,
}: ApplyWhereClauseSuggestionInput): {
	expression: string
	cursor: number
} {
	const safeStart = clampRange(replaceStart, 0, expression.length)
	const safeEnd = clampRange(replaceEnd, safeStart, expression.length)
	const before = Str.slice(0, safeStart)(expression)
	const after = Str.slice(safeEnd)(expression)

	if (context === "operator") {
		const left = Str.replace(/\s*$/, "")(before)
		const right = Str.replace(/^\s*/, "")(after)
		const insertion = ` ${suggestion.insertText} `
		const nextExpression = `${left}${insertion}${right}`

		return {
			expression: nextExpression,
			cursor: left.length + insertion.length,
		}
	}

	if (context === "conjunction") {
		const left = Str.replace(/\s*$/, "")(before)
		const right = Str.replace(/^\s*/, "")(after)
		const insertion = ` ${suggestion.insertText} `
		const nextExpression = `${left}${insertion}${right}`

		return {
			expression: nextExpression,
			cursor: left.length + insertion.length,
		}
	}

	const shouldAddLeadingSpace = before.length > 0 && !/\s$/.test(before)
	const isPrefix = Str.endsWith(".")(suggestion.insertText)
	const shouldAddTrailingSpace = !isPrefix && (after.length === 0 || !/^\s/.test(after))
	const insertion = `${shouldAddLeadingSpace ? " " : ""}${
		suggestion.insertText
	}${shouldAddTrailingSpace ? " " : ""}`

	const nextExpression = `${before}${insertion}${after}`

	return {
		expression: nextExpression,
		cursor: before.length + insertion.length,
	}
}
