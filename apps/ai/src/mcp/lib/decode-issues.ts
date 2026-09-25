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
import { Schema, SchemaIssue } from "effect"

export interface NormalizedArguments {
	readonly args: unknown
	/** Retired names that were rewritten to their current name. */
	readonly renamed: ReadonlyArray<readonly [from: string, to: string]>
	/** Keys the schema does not have, with the parameter each was probably meant to be. */
	readonly unknown: ReadonlyArray<{ readonly key: string; readonly suggestion?: string }>
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

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
	key
		.toLowerCase()
		.split(/[_\s-]+/)
		.filter(Boolean)

/** `cmd` for `command`, `start` for `start_time`: the key's letters, in order, from the same start. */
const abbreviates = (key: string, name: string): boolean => {
	if (key.length < 3 || key[0] !== name[0]) return false
	let at = 0
	for (const letter of name) if (letter === key[at]) at++
	return at === key.length
}

/** The known parameter an unknown key most plausibly meant, if any is close enough. */
export const suggestParameter = (key: string, known: ReadonlyArray<string>): string | undefined => {
	const lower = key.toLowerCase()
	let best: { readonly name: string; readonly score: number } | undefined
	for (const name of known) {
		const distance = editDistance(lower, name.toLowerCase())
		const sharesWord = words(key).some((word) => word.length > 2 && words(name).includes(word))
		const score = abbreviates(lower, name.toLowerCase())
			? 1
			: sharesWord
				? Math.min(distance, 2)
				: distance
		const limit = Math.max(2, Math.floor(name.length / 3))
		if (score <= limit && (best === undefined || score < best.score)) best = { name, score }
	}
	return best?.name
}

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
	const matches = allowed.filter(
		(candidate) => typeof candidate === "string" && candidate.toLowerCase() === value.toLowerCase(),
	)
	return matches.length === 1 ? matches[0] : value
}

/** Each property's `enum`, read off the published JSON Schema. */
export const enumValues = (
	inputSchema: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ReadonlyArray<unknown>> => {
	const properties = isPlainObject(inputSchema.properties) ? inputSchema.properties : {}
	return new Map(
		Object.entries(properties).flatMap(([name, property]) =>
			isPlainObject(property) && Array.isArray(property.enum) ? [[name, property.enum] as const] : [],
		),
	)
}

export const normalizeArguments = (
	input: unknown,
	known: ReadonlyArray<string>,
	aliases: Readonly<Record<string, string>> = {},
	enums: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
): NormalizedArguments => {
	if (!isPlainObject(input)) return { args: input, renamed: [], unknown: [] }
	const knownSet = new Set(known)
	const args: Record<string, unknown> = {}
	const renamed: Array<readonly [string, string]> = []
	const unknown: Array<{ key: string; suggestion?: string }> = []
	for (const [key, value] of Object.entries(input)) {
		if (knownSet.has(key)) {
			args[key] = canonicalEnumValue(value, enums.get(key))
			continue
		}
		const target = aliases[key]
		if (target !== undefined && knownSet.has(target)) {
			// The current name wins when a caller sends both.
			if (!(target in input)) args[target] = canonicalEnumValue(value, enums.get(target))
			renamed.push([key, target])
			continue
		}
		const suggestion = suggestParameter(key, known)
		unknown.push(suggestion === undefined ? { key } : { key, suggestion })
	}
	return { args, renamed, unknown }
}

/** Notes for the result text: how the call was read, when that differs from what was sent. */
export const argumentNotices = (normalized: NormalizedArguments, tool: string): ReadonlyArray<string> => [
	...normalized.unknown.map(({ key, suggestion }) =>
		suggestion === undefined
			? `\`${key}\` is not a parameter of \`${tool}\` and was ignored.`
			: `\`${key}\` is not a parameter of \`${tool}\` and was ignored. Did you mean \`${suggestion}\`?`,
	),
]

interface ParameterDoc {
	readonly type: string
	readonly description?: string
}

const typeOf = (schema: Readonly<Record<string, unknown>>): string => {
	if (Array.isArray(schema.enum))
		return `one of ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`
	if (typeof schema.type === "string") return schema.type === "array" ? "list" : schema.type
	const branches = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: []
	const types = new Set(
		branches.flatMap((branch) =>
			isPlainObject(branch) && typeof branch.type === "string" ? [branch.type] : [],
		),
	)
	// A number published as number-or-numeric-string is a number to the reader.
	if (types.has("number") || types.has("integer")) return "number"
	if (types.has("boolean")) return "boolean"
	if (types.has("array")) return "list"
	return types.size === 0 ? "value" : [...types].join(" or ")
}

/** Each property's type and description, read off the published JSON Schema. */
export const parameterDocs = (
	inputSchema: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ParameterDoc> => {
	const properties = isPlainObject(inputSchema.properties) ? inputSchema.properties : {}
	return new Map(
		Object.entries(properties).flatMap(([name, property]) =>
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
	const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required.map(String) : [])
	const lines = formatter(error.issue).issues.map(({ path: rawPath, message }) => {
		const path = rawPath ?? []
		const name = path.length === 0 ? undefined : String(path[0])
		if (name === undefined) return `- ${message}`
		const nested = path.length > 1 ? ` at ${path.slice(1).map(String).join(".")}` : ""
		return message === "Missing key"
			? `- Missing required ${describeParameter(name, docs)}`
			: `- \`${name}\`${nested}: ${message}`
	})
	const ignored = normalized.unknown.map(({ key, suggestion }) =>
		suggestion === undefined
			? `- \`${key}\` is not a parameter of this tool.`
			: `- \`${key}\` is not a parameter of this tool. Did you mean \`${suggestion}\`?`,
	)
	const names = [...docs.keys()].map((name) => (required.has(name) ? `${name} (required)` : name))
	return [
		`Invalid parameters for \`${tool}\`:`,
		...lines,
		...ignored,
		names.length === 0 ? "This tool takes no parameters." : `Parameters: ${names.join(", ")}.`,
	].join("\n")
}
