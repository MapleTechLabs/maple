/**
 * The parameter vocabulary every MCP tool builds its input schema from.
 *
 * One name, one encoding and one description shape per concept, so a model that learned
 * `service` on one tool is right on the next. Defaults and caps live in the schema, which is
 * also what renders them into the published description: a description cannot claim a
 * default the decoder does not apply.
 */
import { Effect, Option, Schema, SchemaGetter, SchemaTransformation } from "effect"
import { WarehouseTimeInput, type WarehouseDateTime } from "@maple/query-engine"
import { McpInvalidInputError } from "../tools/types"
import { rangeExceededMessage, resolveTimeRange } from "./time"

/**
 * A number, or a numeric string. 12% of agent calls send `"limit":"15"`, so the string branch
 * is load-bearing. `Schema.Finite`, not `Schema.Number`: the latter publishes a string branch of
 * `"Infinity"`/`"NaN"` that invites strings it then rejects. `numberFromString` is `Number(s)`,
 * so the blank guard is what keeps `""` from decoding to `0` (a model's "no value" becoming
 * `limit: 0`); `Finite` rejects `"soon"`.
 */
const NumericString = Schema.String.check(
	Schema.makeFilter((value: string) => value.trim().length > 0, {
		title: "nonBlankNumericString",
		expected: "a number, or omit the parameter (an empty string is not a number)",
	}),
).pipe(Schema.decodeTo(Schema.Finite, SchemaTransformation.numberFromString))

const NumberLike = Schema.Union([Schema.Finite, NumericString])

/** `true`/`false`, plus the string spellings models reach for. */
const BooleanString = Schema.Literals(["true", "false", "1", "0"]).pipe(
	Schema.decodeTo(
		Schema.Boolean,
		SchemaTransformation.transform({
			decode: (value) => value === "true" || value === "1",
			encode: (value) => (value ? "true" : "false"),
		}),
	),
)

const BooleanLike = Schema.Union([Schema.Boolean, BooleanString])

/** Trimmed; a blank string is how a model says "no filter", so it decodes as absent. */
const OPTIONAL_TEXT_TRANSFORMATION = {
	decode: SchemaGetter.transformOptional((option: Option.Option<string | undefined>) =>
		option.pipe(
			Option.flatMap(Option.fromUndefinedOr),
			Option.map((value) => value.trim()),
			Option.filter((value) => value !== ""),
		),
	),
	encode: SchemaGetter.passthrough<string | undefined>(),
}

export const text = (description: string) => Schema.String.annotate({ description })

/**
 * Annotations on a transformed schema land on its decoded side; the published JSON Schema is the
 * encoded side. Each helper below therefore annotates the wire schema before transforming it.
 */
export const optionalText = (description: string) =>
	Schema.optional(Schema.String.annotate({ description })).pipe(
		Schema.decodeTo(Schema.optional(Schema.String), OPTIONAL_TEXT_TRANSFORMATION),
	)

export const number = (description: string) => NumberLike.annotate({ description })

export const optionalNumber = (description: string) => Schema.optional(NumberLike).annotate({ description })

export const flag = (description: string) => BooleanLike.annotate({ description })

export const optionalFlag = (description: string) => Schema.optional(BooleanLike).annotate({ description })

/** A closed set of values, listed in the schema's `enum` so a model never guesses the spelling. */
export const oneOf = <const L extends ReadonlyArray<string>>(values: L, description: string) =>
	Schema.Literals(values).annotate({ description })

export const optionalOneOf = <const L extends ReadonlyArray<string>>(values: L, description: string) =>
	Schema.optional(Schema.Literals(values)).annotate({ description })

/**
 * A list. Published as an array; a comma-separated string is still accepted because every
 * `*_names` parameter used to be one.
 */
const CommaList = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Array(Schema.String),
		SchemaTransformation.transform<ReadonlyArray<string>, string>({
			decode: (value) =>
				value
					.split(",")
					.map((part) => part.trim())
					.filter((part) => part !== ""),
			encode: (values) => values.join(","),
		}),
	),
)

export const list = (description: string) =>
	Schema.Union([Schema.Array(Schema.String), CommaList]).annotate({ description })

export const optionalList = (description: string) =>
	Schema.optional(Schema.Union([Schema.Array(Schema.String), CommaList])).annotate({ description })

/**
 * A structured value a tool takes as JSON. Accepts the object itself or its JSON text, and
 * decodes it against the real schema, so a malformed field is a parameter error naming the
 * field rather than a handler-side `JSON.parse` failure.
 */
export const json = <S extends Schema.Codec<unknown, unknown, never, never>>(
	schema: S,
	description: string,
) => Schema.Union([Schema.fromJsonString(schema), schema]).annotate({ description })

export const optionalJson = <S extends Schema.Codec<unknown, unknown, never, never>>(
	schema: S,
	description: string,
) => Schema.optional(json(schema, description))

const clampTo = (spec: { readonly min: number; readonly max: number }) =>
	SchemaTransformation.transform<number, number>({
		decode: (value) => Math.min(Math.max(spec.min, Math.floor(value)), spec.max),
		encode: (value) => value,
	})

/**
 * A page size. Absent means the default; out-of-range values clamp, since a model asking for
 * 10,000 rows wants "as many as you allow", not an error.
 */
export const limit = (
	spec: { readonly default: number; readonly max: number } & (
		| { readonly noun: string }
		/** A full sentence, for a bound that is not a page size; the default and max are appended. */
		| { readonly description: string }
	),
) =>
	NumberLike.annotate({
		description:
			"noun" in spec
				? `Max ${spec.noun} to return (default ${spec.default}, max ${spec.max})`
				: `${spec.description} (default ${spec.default}, max ${spec.max})`,
	}).pipe(
		Schema.decodeTo(Schema.Int, clampTo({ min: 1, max: spec.max })),
		Schema.withDecodingDefaultType(Effect.succeed(spec.default)),
	)

/** Rows to skip when paging. Deep offsets scan the skipped rows, so they are capped too. */
export const offset = (spec: { readonly max: number }) =>
	NumberLike.annotate({
		description: "Rows to skip, for paging (default 0). Use the `next` call a truncated result gives.",
	}).pipe(
		Schema.decodeTo(Schema.Int, clampTo({ min: 0, max: spec.max })),
		Schema.withDecodingDefaultType(Effect.succeed(0)),
	)

const TIMESTAMP_FORMAT = "UTC (YYYY-MM-DD HH:mm:ss or ISO 8601)"

/** A single point in time, worded like the window bounds: `meaning` then the accepted format. */
export const timestamp = (meaning: string) =>
	WarehouseTimeInput.annotate({ description: `${meaning}, ${TIMESTAMP_FORMAT}` })

export const optionalTimestamp = (meaning: string) =>
	Schema.optional(WarehouseTimeInput).annotate({ description: `${meaning}, ${TIMESTAMP_FORMAT}` })

/** The one spelling of a service filter. `service_name` is accepted as an alias by the registry. */
export const service = (description = "Only this service (exact `service.name`)") => optionalText(description)

export const environment = (description = "Only this deployment environment (e.g. production, staging)") =>
	optionalText(description)

/** Aliases every tool that takes {@link service} accepts, hidden from the published schema. */
export const SERVICE_ALIASES = { service_name: "service" } as const

const formatHours = (hours: number): string =>
	hours % 24 === 0
		? `${hours / 24} day${hours === 24 ? "" : "s"}`
		: `${hours} hour${hours === 1 ? "" : "s"}`

export interface TimeWindowSpec {
	/** Window used when neither bound is given. */
	readonly defaultHours: number
	/** Widest window the tool accepts; wider is an input error rather than a silent clamp. */
	readonly maxHours?: number
}

/**
 * `start_time`/`end_time`, with the default and the cap stated in the published description
 * and enforced by the same object. `resolve` is the only way a tool turns them into bounds.
 */
export const timeWindow = (spec: TimeWindowSpec) => {
	const cap =
		spec.maxHours === undefined ? "" : ` The window may span at most ${formatHours(spec.maxHours)}.`
	return {
		spec,
		fields: {
			start_time: Schema.optional(WarehouseTimeInput).annotate({
				description: `Start of the window, ${TIMESTAMP_FORMAT}. Default: ${formatHours(spec.defaultHours)} before end_time.${cap}`,
			}),
			end_time: Schema.optional(WarehouseTimeInput).annotate({
				description: `End of the window, ${TIMESTAMP_FORMAT}. Default: now.`,
			}),
		},
		resolve: (
			params: {
				readonly start_time?: WarehouseDateTime | undefined
				readonly end_time?: WarehouseDateTime | undefined
			},
			tool: string,
		): Effect.Effect<
			{ readonly st: WarehouseDateTime; readonly et: WarehouseDateTime },
			McpInvalidInputError
		> => {
			const range = resolveTimeRange(params.start_time, params.end_time, spec)
			if (range.requestedHours < 0) {
				return Effect.fail(
					new McpInvalidInputError({
						message: `start_time (${range.st}) is after end_time (${range.et}).`,
						parameter: "start_time",
					}),
				)
			}
			if (range.exceeded) {
				return Effect.fail(
					new McpInvalidInputError({
						message: rangeExceededMessage(range, tool),
						parameter: "start_time",
					}),
				)
			}
			return Effect.succeed({ st: range.st, et: range.et })
		},
	}
}
