/**
 * The parameter vocabulary every MCP tool builds its input schema from.
 *
 * One name, one encoding and one description shape per concept, so a model that learned
 * `service` on one tool is right on the next. Defaults and caps live in the schema, which is
 * also what renders them into the published description: a description cannot claim a
 * default the decoder does not apply.
 */
import { Clock, Effect, Option, Schema, SchemaGetter, SchemaTransformation } from "effect"
import { decodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { AlertDestinationId, AlertRuleId, DashboardId, ErrorIssueId } from "@maple/domain/primitives"
import { WarehouseTimeInput, type WarehouseDateTime } from "@maple/query-engine"
import { McpInvalidInputError } from "../tools/types"
import { resolveWindow } from "./time"
import { CurrentWindowNotes } from "./window-notes"

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

/** `"auto"`, a value a schema-validating client can send where the published schema cannot say null. */
const AutoAsNull = Schema.Literal("auto").pipe(
	Schema.decodeTo(
		Schema.Null,
		SchemaTransformation.transform({ decode: () => null, encode: () => "auto" as const }),
	),
)

/**
 * A closed set of numbers in the schema's `enum` (a numeric string decodes too), or `"auto"` to
 * clear the value. `null` clears it too, but the published schema drops the null branch.
 */
export const optionalNullableNumberOneOf = <const L extends ReadonlyArray<number>>(
	values: L,
	description: string,
) => {
	const literals = Schema.Literals(values)
	return Schema.optional(
		Schema.NullOr(Schema.Union([literals, NumericString.pipe(Schema.decodeTo(literals)), AutoAsNull])),
	).annotate({ description })
}

/** Several values from a closed set, each listed in the item schema's `enum`. */
export const optionalOneOfList = <const L extends ReadonlyArray<string>>(values: L, description: string) =>
	Schema.optional(Schema.Array(Schema.Literals(values))).annotate({ description })

/**
 * A list. Published as an array; a comma-separated string is still accepted because every
 * `*_names` parameter used to be one.
 */
const COMMA_SPLIT = SchemaTransformation.transform<ReadonlyArray<string>, string>({
	decode: (value) =>
		value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part !== ""),
	encode: (values) => values.join(","),
})

const CommaList = Schema.String.pipe(Schema.decodeTo(Schema.Array(Schema.String), COMMA_SPLIT))

export const list = (description: string) =>
	Schema.Union([Schema.Array(Schema.String), CommaList]).annotate({ description })

export const optionalList = (description: string) =>
	Schema.optional(Schema.Union([Schema.Array(Schema.String), CommaList])).annotate({ description })

/** The resources a tool takes ids for, with their REST public-id prefix and internal id schema. */
const RESOURCE_IDS = {
	alertRule: { prefix: PublicIdPrefixes.alertRule, schema: AlertRuleId, noun: "alert rule" },
	alertDestination: {
		prefix: PublicIdPrefixes.alertDestination,
		schema: AlertDestinationId,
		noun: "alert destination",
	},
	dashboard: { prefix: PublicIdPrefixes.dashboard, schema: DashboardId, noun: "dashboard" },
	errorIssue: { prefix: PublicIdPrefixes.errorIssue, schema: ErrorIssueId, noun: "error issue" },
} as const

export type ResourceIdKind = keyof typeof RESOURCE_IDS

const KNOWN_PREFIXES: ReadonlySet<string> = new Set(Object.values(PublicIdPrefixes))

/**
 * The internal id behind `raw`: its REST public id (`dest_…`) decodes, anything else passes
 * through for the lookup to judge. None when it is malformed or another resource's public id.
 */
export const internalIdOf = (kind: ResourceIdKind, raw: string): Option.Option<string> => {
	const { prefix } = RESOURCE_IDS[kind]
	const value = raw.trim()
	if (value.startsWith(`${prefix}_`)) return Option.fromNullOr(decodePublicId(prefix, value))
	const other = /^([a-z]+)_/.exec(value)?.[1]
	return other !== undefined && KNOWN_PREFIXES.has(other) ? Option.none() : Option.some(value)
}

/**
 * Trimmed, with a REST id swapped for the internal id. Anything else stays as sent, so the tool's
 * own lookup reports it as invalid input on the parameter.
 */
const normalizedId = (kind: ResourceIdKind) =>
	Schema.String.pipe(
		Schema.decodeTo(
			Schema.String,
			SchemaTransformation.transform({
				decode: (raw: string) => Option.getOrElse(internalIdOf(kind, raw), () => raw.trim()),
				encode: (id: string) => id,
			}),
		),
	)

const idHint = (kind: ResourceIdKind) => `its UUID or its REST id (${RESOURCE_IDS[kind].prefix}_…)`

/** One resource id: the internal UUID or the REST public id, decoded to the internal id. */
export const resourceId = (kind: ResourceIdKind, description: string) =>
	Schema.String.annotate({ description: `${description}: ${idHint(kind)}` }).pipe(
		Schema.decodeTo(normalizedId(kind)),
	)

export const optionalResourceId = (kind: ResourceIdKind, description: string) =>
	Schema.optional(resourceId(kind, description))

/** A resource id as its branded type, or invalid input on `parameter` naming the accepted forms. */
export const decodeResourceId =
	<K extends ResourceIdKind>(kind: K, parameter: string) =>
	(raw: string): Effect.Effect<(typeof RESOURCE_IDS)[K]["schema"]["Type"], McpInvalidInputError> => {
		const schema: (typeof RESOURCE_IDS)[K]["schema"] = RESOURCE_IDS[kind].schema
		return Option.match(internalIdOf(kind, raw), {
			onNone: () => Effect.fail(invalidId(kind, raw, parameter)),
			onSome: (id) =>
				Schema.decodeUnknownEffect(schema)(id).pipe(
					Effect.mapError(() => invalidId(kind, raw, parameter)),
				),
		})
	}

const invalidId = (kind: ResourceIdKind, raw: string, parameter: string) =>
	new McpInvalidInputError({
		message: `Invalid ${RESOURCE_IDS[kind].noun} id "${raw}": pass ${idHint(kind)}.`,
		parameter,
	})

/** A comma-separated string with no ids in it is a model's "nothing", not a request to clear a list. */
const NonBlankCommaList = Schema.String.check(
	Schema.makeFilter((value: string) => value.split(",").some((part) => part.trim() !== ""), {
		title: "nonBlankList",
		expected: "at least one id; pass [] to clear the list",
	}),
).pipe(Schema.decodeTo(Schema.Array(Schema.String), COMMA_SPLIT))

/**
 * Several resource ids, each its UUID or REST id. `[]` is a real empty list; a blank string is
 * rejected unless `blankIsEmpty`, for a list where empty cannot clear anything (a new rule).
 */
export const resourceIdList = (
	kind: ResourceIdKind,
	description: string,
	options: { readonly blankIsEmpty?: boolean } = {},
) =>
	Schema.Union([Schema.Array(Schema.String), options.blankIsEmpty === true ? CommaList : NonBlankCommaList])
		.annotate({
			description: `${description}. Each is ${idHint(kind)}`,
		})
		.pipe(Schema.decodeTo(Schema.Array(normalizedId(kind))))

export const optionalResourceIdList = (kind: ResourceIdKind, description: string) =>
	Schema.optional(resourceIdList(kind, description))

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
	/** Widest window the tool scans; a wider request keeps end_time and moves start_time, with a notice. */
	readonly maxHours?: number
}

/**
 * `start_time`/`end_time`, with the default and the cap stated in the published description
 * and enforced by the same object. `resolve` is the only way a tool turns them into bounds.
 */
export const timeWindow = (spec: TimeWindowSpec) => {
	const cap =
		spec.maxHours === undefined
			? ""
			: ` Covers at most ${formatHours(spec.maxHours)}: a wider window keeps end_time and is narrowed to the ${formatHours(spec.maxHours)} before it.`
	return {
		spec,
		fields: {
			start_time: Schema.optional(WarehouseTimeInput).annotate({
				description: `Start of the window, ${TIMESTAMP_FORMAT}. Default: ${formatHours(spec.defaultHours)} before end_time.${cap}`,
			}),
			end_time: Schema.optional(WarehouseTimeInput).annotate({
				description: `End of the window, ${TIMESTAMP_FORMAT}. Default: now; a future time is clamped to now.`,
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
		> =>
			Effect.gen(function* () {
				const resolution = resolveWindow(
					params.start_time,
					params.end_time,
					{ ...spec, tool },
					yield* Clock.currentTimeMillis,
				)
				if (resolution._tag === "Rejected") {
					return yield* new McpInvalidInputError({
						message: resolution.message,
						parameter: "start_time",
					})
				}
				const notes = yield* CurrentWindowNotes
				notes?.record(resolution.now, resolution.notices)
				return { st: resolution.st, et: resolution.et }
			}),
	}
}
