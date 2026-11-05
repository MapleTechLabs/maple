// BOUNDARY: This module reads unparsed tool arguments and published JSON Schemas before decoding.
/**
 * What a model is told when its arguments do not fit a tool's schema, and how arguments are
 * normalized before decoding.
 *
 * Most parameter failures in production were the model sending the wrong key, not a wrong value:
 * `sandbox_grep` without `pattern`, `sandbox_exec` with `args` but no `command`. A raw
 * `SchemaError` ("Missing key at ["pattern"]") says what failed but not what the parameter is, so
 * the message here names each bad parameter with its type and description, and points unknown
 * keys at the parameter they were probably meant to be.
 */
import { Option, Schema, SchemaIssue, Array as Arr, Record as Rec, String as Str } from "effect"
import { parseWarehouseDateTime, warehouseDateTime } from "@maple/query-engine"
import { stringifyJson } from "./json"

export interface NormalizedArguments {
	readonly args: unknown
	/** Retired names that were rewritten to their current name. */
	readonly renamed: ReadonlyArray<readonly [from: string, to: string]>
	/** Keys the schema does not have, with the parameters each was probably meant to be. */
	readonly unknown: ReadonlyArray<UnknownArgument>
	/** How a relative `time_range` was read, for the result's warnings. */
	readonly expanded?: ReadonlyArray<string>
}

export interface UnknownArgument {
	readonly key: string
	/** Empty when no parameter is close; both bounds for a key that names a whole window. */
	readonly suggestions: ReadonlyArray<string>
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const editDistance = (a: string, b: string): number => {
	const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0]!
		previous[0] = i
		for (let j = 1; j <= b.length; j++) {
			const above = previous[j]!
			previous[j] = Math.min(
				above + 1,
				previous[j - 1]! + 1,
				diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
			)
			diagonal = above
		}
	}
	return previous[b.length]!
}

const words = (key: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(/[_\s-]+/)(Str.toLowerCase(key)), Boolean)

/** `cmd` for `command`, `start` for `start_time`: the key's letters, in order, from the same start. */
const abbreviates = (key: string, name: string): boolean => {
	if (key.length < 3 || key[0] !== name[0]) return false
	let at = 0
	for (const letter of name) if (letter === key[at]) at++
	return at === key.length
}

/** The known parameter an unknown key most plausibly meant, if any is close enough. */
export const suggestParameter = (key: string, known: ReadonlyArray<string>): string | undefined => {
	const lower = Str.toLowerCase(key)
	let best: { readonly name: string; readonly score: number } | undefined
	for (const name of known) {
		const distance = editDistance(lower, Str.toLowerCase(name))
		const sharesWord = Arr.some(words(key), (word) => word.length > 2 && words(name).includes(word))
		const score = abbreviates(lower, Str.toLowerCase(name))
			? 1
			: sharesWord
				? Math.min(distance, 2)
				: distance
		const limit = Math.max(2, Math.floor(name.length / 3))
		if (score <= limit && (best === undefined || score < best.score)) best = { name, score }
	}
	return best?.name
}

/** Words that name a whole time window (`time_range`, `lookback`) rather than one of its bounds. */
const WINDOW_WORDS: ReadonlySet<string> = new Set([
	"range",
	"window",
	"timerange",
	"timeframe",
	"timespan",
	"period",
	"since",
	"lookback",
	"duration",
	"last",
	"ago",
])

const isWindowKey = (key: string): boolean =>
	Str.toLowerCase(key) === "time" || Arr.some(words(key), (word) => WINDOW_WORDS.has(word))

const WINDOW_BOUNDS: ReadonlyArray<string> = ["start_time", "end_time"]

/**
 * The parameters an unknown key most plausibly meant: `time_range` is both window bounds. A closer
 * match that is not a bound wins, so `min_duration` still points at `min_duration_ms`.
 */
const suggestParameters = (key: string, known: ReadonlyArray<string>): ReadonlyArray<string> => {
	const suggestion = suggestParameter(key, known)
	const widens =
		(suggestion === undefined || WINDOW_BOUNDS.includes(suggestion)) &&
		isWindowKey(key) &&
		Arr.every(WINDOW_BOUNDS, (bound) => known.includes(bound))
	if (widens) return WINDOW_BOUNDS
	return suggestion === undefined ? [] : [suggestion]
}

const didYouMean = (suggestions: ReadonlyArray<string>): string =>
	suggestions.length === 0
		? ""
		: ` Did you mean ${Arr.join(
				Arr.map(suggestions, (name) => `\`${name}\``),
				"/",
			)}?`

/**
 * Apply aliases and drop keys the schema does not declare. A dropped key is reported rather than
 * silently ignored: a model that sent `service_name` to a tool without it believed it filtered.
 */
/**
 * The published value a string matches ignoring case, when exactly one does: `"error"` for an
 * `ERROR` severity is the model saying the right thing in the wrong case, not a wrong value.
 */
const canonicalEnumValue = (value: unknown, allowed: ReadonlyArray<unknown> | undefined): unknown => {
	if (typeof value !== "string" || allowed === undefined || allowed.includes(value)) return value
	const matches = Arr.filter(
		allowed,
		(candidate) => typeof candidate === "string" && Str.toLowerCase(candidate) === Str.toLowerCase(value),
	)
	return matches.length === 1 ? matches[0] : value
}

/** Each property's `enum`, read off the published JSON Schema. */
export const enumValues = (
	inputSchema: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ReadonlyArray<unknown>> => {
	const properties = isPlainObject(inputSchema.properties) ? inputSchema.properties : {}
	return new Map(
		Arr.flatMap(Rec.toEntries(properties), ([name, property]) =>
			isPlainObject(property) && Arr.isArray(property.enum) ? [[name, property.enum] as const] : [],
		),
	)
}

export const normalizeArguments = (
	input: unknown,
	known: ReadonlyArray<string>,
	aliases: Readonly<Record<string, string>> = {},
	enums: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
	nowMs?: number,
): NormalizedArguments => {
	if (!isPlainObject(input)) return { args: input, renamed: [], unknown: [] }
	const knownSet = new Set(known)
	const args: Record<string, unknown> = {}
	const renamed: Array<readonly [string, string]> = []
	const unknown: Array<UnknownArgument> = []
	const expanded: Array<string> = []
	const lookbacks: Array<readonly [key: string, value: unknown, ms: number]> = []
	for (const [key, value] of Rec.toEntries(input)) {
		if (knownSet.has(key)) {
			args[key] = canonicalEnumValue(value, enums.get(key))
			continue
		}
		// Before aliases: `since: "24h"` is a lookback, `since: "2026-11-01 00:00:00"` the alias.
		const lookbackMs = nowMs === undefined ? undefined : lookbackDurationMs(key, value, knownSet)
		if (lookbackMs !== undefined) {
			lookbacks.push([key, value, lookbackMs])
			continue
		}
		const target = aliasTarget(key, value, knownSet, aliases)
		if (target !== undefined) {
			// The current name wins when a caller sends both.
			if (!(target in input)) args[target] = canonicalEnumValue(value, enums.get(target))
			renamed.push([key, target])
			continue
		}
		unknown.push({ key, suggestions: suggestParameters(key, known) })
	}
	// After every alias, so an explicit start wins and the lookback ends at the resolved end_time.
	for (const [key, value, ms] of lookbacks) {
		if (nowMs === undefined || args.start_time !== undefined) {
			unknown.push({ key, suggestions: suggestParameters(key, known) })
			continue
		}
		const end = typeof args.end_time === "string" ? warehouseTimeMs(args.end_time) : undefined
		const start = warehouseDateTime((end ?? nowMs) - ms)
		args.start_time = start
		renamed.push([key, "start_time"])
		expanded.push(
			`\`${key}: ${stringifyJson(value)}\` was read as start_time=${start} (UTC), ${end === undefined ? "to now" : "before end_time"}.`,
		)
	}
	return { args, renamed, unknown, ...(expanded.length === 0 ? undefined : { expanded }) }
}

const snakeCase = (key: string): string => Str.toLowerCase(Str.replace(/([a-z0-9])([A-Z])/g, "$1_$2")(key))

/**
 * The declared parameter an undeclared key names: a published alias, the key in snake_case
 * (`issueId`), or its singular/plural twin (`workflow_states`, `environment`). A list (or a
 * comma list) never maps onto the singular twin, which takes one value.
 */
const aliasTarget = (
	key: string,
	value: unknown,
	known: ReadonlySet<string>,
	aliases: Readonly<Record<string, string>>,
): string | undefined => {
	const snake = snakeCase(key)
	const isList = Arr.isArray(value) || (typeof value === "string" && Str.includes(",")(value))
	const twin = Str.endsWith("s")(snake) ? (isList ? undefined : Str.slice(0, -1)(snake)) : `${snake}s`
	const candidates = [aliases[key], snake, aliases[snake], twin]
	return Option.getOrUndefined(
		Arr.findFirst(
			candidates,
			(candidate) => candidate !== undefined && candidate !== key && known.has(candidate),
		),
	)
}

const RELATIVE_UNITS_MS = new Map([
	["m", 60_000],
	["h", 3_600_000],
	["d", 86_400_000],
	["w", 604_800_000],
])

/** Keys that name a whole lookback. Not `window` or `duration`: `window_minutes`, `min_duration_ms`. */
const LOOKBACK_KEYS: ReadonlySet<string> = new Set([
	"time_range",
	"timerange",
	"time_frame",
	"timeframe",
	"time_window",
	"timespan",
	"lookback",
	"since",
	"period",
	"last",
	"range",
])

/** A wire timestamp (`YYYY-MM-DD HH:mm:ss` or ISO 8601, UTC) in epoch ms, when it parses. */
const warehouseTimeMs = (value: string): number | undefined => {
	const ms = parseWarehouseDateTime(value)
	return Number.isNaN(ms) ? undefined : ms
}

/** `6h`, `30m`, `7 days`, `last 24 hours`: a lookback ending at end_time, else now. */
const RELATIVE_DURATION =
	/^(?:last\s+|past\s+)?(\d{1,4})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)(?:\s+ago)?$/i

/** Longest lookback read from a duration: past it the window is a typo, not a request. */
const MAX_LOOKBACK_MS = 400 * 86_400_000

/** A lookback key holding a relative duration (`6h`, `last 2 days`), in ms. */
const lookbackDurationMs = (key: string, value: unknown, known: ReadonlySet<string>): number | undefined => {
	if (!LOOKBACK_KEYS.has(snakeCase(key)) || !known.has("start_time") || typeof value !== "string")
		return undefined
	const match = RELATIVE_DURATION.exec(Str.trim(value))
	if (match === null) return undefined
	const unit = RELATIVE_UNITS_MS.get(Str.slice(0, 1)(Str.toLowerCase(match[2] ?? "")))
	const ms = unit === undefined ? 0 : Number(match[1]) * unit
	return ms > 0 && ms <= MAX_LOOKBACK_MS ? ms : undefined
}

/**
 * Warnings for the result text, one per ignored key. The call still ran, so each says the result
 * is for the call without that key: a model that sent `time_range` otherwise reads a default window.
 */
export const argumentWarnings = (normalized: NormalizedArguments, tool: string): ReadonlyArray<string> => [
	...(normalized.expanded ?? []),
	...Arr.map(
		normalized.unknown,
		({ key, suggestions }) =>
			`\`${key}\` is not a parameter of \`${tool}\`. It was ignored, and this result is for the call without it.${didYouMean(suggestions)}`,
	),
]

interface ParameterDoc {
	readonly type: string
	readonly description?: string
}

const typeOf = (schema: Readonly<Record<string, unknown>>): string => {
	if (Arr.isArray(schema.enum))
		return `one of ${Arr.join(
			Arr.map(schema.enum, (value) => stringifyJson(value) ?? ""),
			", ",
		)}`
	if (typeof schema.type === "string") return schema.type === "array" ? "list" : schema.type
	const branches = Arr.isArray(schema.anyOf) ? schema.anyOf : Arr.isArray(schema.oneOf) ? schema.oneOf : []
	const types = new Set(
		Arr.flatMap(branches, (branch) =>
			isPlainObject(branch) && typeof branch.type === "string" ? [branch.type] : [],
		),
	)
	// A number published as number-or-numeric-string is a number to the reader.
	if (types.has("number") || types.has("integer")) return "number"
	if (types.has("boolean")) return "boolean"
	if (types.has("array")) return "list"
	return types.size === 0 ? "value" : Arr.join([...types], " or ")
}

/** Each property's type and description, read off the published JSON Schema. */
export const parameterDocs = (
	inputSchema: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ParameterDoc> => {
	const properties = isPlainObject(inputSchema.properties) ? inputSchema.properties : {}
	return new Map(
		Arr.flatMap(Rec.toEntries(properties), ([name, property]) =>
			isPlainObject(property)
				? [
						[
							name,
							typeof property.description === "string"
								? { type: typeOf(property), description: property.description }
								: { type: typeOf(property) },
						] as const,
					]
				: [],
		),
	)
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()
/** A Standard Schema path segment is a key or an object holding one. */
const segmentName = (segment: PropertyKey | { readonly key: PropertyKey }): string =>
	String(typeof segment === "object" ? segment.key : segment)

const describeParameter = (name: string, docs: ReadonlyMap<string, ParameterDoc>): string => {
	const parameter = docs.get(name)
	if (parameter === undefined) return `\`${name}\``
	return parameter.description === undefined
		? `\`${name}\` (${parameter.type})`
		: `\`${name}\` (${parameter.type}): ${parameter.description}`
}

/**
 * The message for a call whose arguments failed to decode: one line per bad parameter, then the
 * ignored keys and their likely meaning, then the full parameter list.
 */
export const formatDecodeFailure = (
	tool: string,
	error: Schema.SchemaError,
	inputSchema: Readonly<Record<string, unknown>>,
	normalized: NormalizedArguments,
): string => {
	const docs = parameterDocs(inputSchema)
	const required = new Set(Arr.isArray(inputSchema.required) ? Arr.map(inputSchema.required, String) : [])
	const lines = Arr.map(formatter(error.issue).issues, ({ path: rawPath, message }) => {
		const path = rawPath ?? []
		const name = path.length === 0 ? undefined : segmentName(path[0])
		if (name === undefined) return `- ${message}`
		const nested = path.length > 1 ? ` at ${Arr.join(Arr.map(path.slice(1), segmentName), ".")}` : ""
		return message === "Missing key"
			? `- Missing required ${describeParameter(name, docs)}`
			: `- \`${name}\`${nested}: ${message}`
	})
	const ignored = Arr.map(
		normalized.unknown,
		({ key, suggestions }) => `- \`${key}\` is not a parameter of this tool.${didYouMean(suggestions)}`,
	)
	const names = Arr.map([...docs.keys()], (name) => (required.has(name) ? `${name} (required)` : name))
	return Arr.join(
		[
			`Invalid parameters for \`${tool}\`:`,
			...lines,
			...ignored,
			names.length === 0 ? "This tool takes no parameters." : `Parameters: ${Arr.join(names, ", ")}.`,
		],
		"\n",
	)
}
