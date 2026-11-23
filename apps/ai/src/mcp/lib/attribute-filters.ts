// Attribute predicates as a model writes them, and their engine shape: shared by query_data's
// `attribute_filters` and every product-analytics tool's user and account property filters.
import { Effect, Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { McpInvalidInputError } from "../tools/types"
import { stringifyJson } from "./json"
import * as P from "./params"

export const ATTRIBUTE_SCOPES = ["span", "resource"] as const
export type AttributeScope = (typeof ATTRIBUTE_SCOPES)[number]

const ATTRIBUTE_FILTER_MODES = ["equals", "contains", "exists", "gt", "gte", "lt", "lte", "in"] as const
export const MAX_ATTRIBUTE_FILTERS = 8

/** One more attribute condition, as a model writes it: the engine's filter, with its scope beside it. */
export const AttributeFilterParam = Schema.Struct({
	key: Schema.String,
	value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
	values: Schema.optionalKey(Schema.Array(Schema.String)),
	mode: Schema.optionalKey(Schema.Literals(ATTRIBUTE_FILTER_MODES)),
	negated: Schema.optionalKey(Schema.Boolean),
	scope: Schema.optionalKey(Schema.Literals(ATTRIBUTE_SCOPES)),
})
export type AttributeFilterParam = typeof AttributeFilterParam.Type

/** An attribute predicate in the engine's shape. */
export interface EngineAttributeFilter {
	readonly key: string
	readonly value?: string
	readonly values?: ReadonlyArray<string>
	readonly mode: (typeof ATTRIBUTE_FILTER_MODES)[number]
	readonly negated?: true
}

const COMPARISON_MODES: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte"])

/** A filter with the scope and negation its entry asked for. */
const scoped = (
	entry: AttributeFilterParam,
	filter: EngineAttributeFilter,
): { readonly scope?: AttributeScope; readonly filter: EngineAttributeFilter } => ({
	...(entry.scope === undefined ? undefined : { scope: entry.scope }),
	filter: entry.negated === true ? { ...filter, negated: true } : filter,
})

/**
 * `attribute_filters` in the engine's shape, or the first entry that cannot be one. A mode left
 * out is read from what was sent: `values` is `in`, a `value` is `equals`, neither is `exists`.
 */
export const engineAttributeFilters = (
	filters: ReadonlyArray<AttributeFilterParam>,
): Result.Result<
	ReadonlyArray<{ readonly scope?: AttributeScope; readonly filter: EngineAttributeFilter }>,
	string
> => {
	if (filters.length > MAX_ATTRIBUTE_FILTERS) {
		return Result.fail(
			`attribute_filters takes at most ${MAX_ATTRIBUTE_FILTERS} conditions; got ${filters.length}.`,
		)
	}
	return Result.all(
		Arr.map(filters, (entry) => {
			const key = Str.trim(entry.key)
			const refuse = (why: string) => Result.fail(`attribute_filters "${key}": ${why}`)
			if (key === "") return Result.fail("An attribute_filters entry has an empty `key`.")
			if (entry.value !== undefined && entry.values !== undefined) {
				return refuse("pass `value`, or `values` with mode=in, not both.")
			}
			const mode =
				entry.mode ??
				(entry.values !== undefined ? "in" : entry.value === undefined ? "exists" : "equals")
			if (mode === "in") {
				return entry.values === undefined || entry.values.length === 0
					? refuse("mode=in needs a non-empty `values` array.")
					: Result.succeed(scoped(entry, { key, mode, values: entry.values }))
			}
			if (entry.values !== undefined)
				return refuse(`\`values\` is for mode=in; mode=${mode} takes a \`value\`.`)
			if (mode === "exists") {
				return entry.value === undefined
					? Result.succeed(scoped(entry, { key, mode }))
					: refuse("mode=exists takes no `value`. Use mode=equals to match it.")
			}
			if (entry.value === undefined) return refuse(`mode=${mode} needs a \`value\`.`)
			const value = String(entry.value)
			// The engine compares these as numbers: text would compare as NaN and match nothing.
			if (COMPARISON_MODES.has(mode) && (Str.trim(value) === "" || !Number.isFinite(Number(value)))) {
				return refuse(`mode=${mode} compares numbers, and "${value}" is not one.`)
			}
			return Result.succeed(scoped(entry, { key, mode, value }))
		}),
	)
}

/** A property filter: an attribute filter without a `scope`, since properties have one map. */
const PropertyFilterParam = AttributeFilterParam.mapFields(({ scope: _, ...fields }) => fields)

/** `user_property_filters` and `group_property_filters`, for every tool that reads product events. */
export const PROPERTY_FILTER_FIELDS = {
	user_property_filters: P.optionalJson(
		Schema.Array(PropertyFilterParam),
		"Only the people whose user properties match: identify() traits and set/set_once writes, at their current value. The same {key, value, mode, negated} entries as attribute_filters. " +
			'Example: [{"key":"plan","value":"pro"}]. Keys from explore_attributes source=user_properties.',
	),
	group_property_filters: P.optionalJson(
		Schema.Array(PropertyFilterParam),
		"Only the accounts (group_id) whose properties match, as user_property_filters. Keys from explore_attributes source=group_properties.",
	),
}

/** The two filter lists in the engine's shape, present only when set; a bad entry is a caller error. */
export const propertyFiltersOf = Effect.fn("McpTool.propertyFilters")(function* (params: {
	readonly user_property_filters?: ReadonlyArray<typeof PropertyFilterParam.Type> | undefined
	readonly group_property_filters?: ReadonlyArray<typeof PropertyFilterParam.Type> | undefined
}) {
	const parse = (name: "user_property_filters" | "group_property_filters") =>
		Result.match(engineAttributeFilters(params[name] ?? []), {
			onFailure: (message) =>
				Effect.fail(
					new McpInvalidInputError({
						message: Str.replace("attribute_filters", name)(message),
						parameter: name,
						example: `${name}=[{"key":"plan","value":"pro"}]`,
					}),
				),
			onSuccess: (entries) => Effect.succeed(Arr.map(entries, (entry) => entry.filter)),
		})
	const user = yield* parse("user_property_filters")
	const group = yield* parse("group_property_filters")
	return {
		...(user.length > 0 ? { userPropertyFilters: user } : undefined),
		...(group.length > 0 ? { groupPropertyFilters: group } : undefined),
	}
})

/** The property filters as given, as tool arguments, so a suggested follow-up keeps them. */
export const propertyFilterArgs = (params: {
	readonly user_property_filters?: ReadonlyArray<typeof PropertyFilterParam.Type> | undefined
	readonly group_property_filters?: ReadonlyArray<typeof PropertyFilterParam.Type> | undefined
}): Record<string, string> =>
	Rec.filter(
		{
			user_property_filters:
				params.user_property_filters === undefined
					? undefined
					: stringifyJson(params.user_property_filters),
			group_property_filters:
				params.group_property_filters === undefined
					? undefined
					: stringifyJson(params.group_property_filters),
		},
		(value): value is string => value !== undefined,
	)
