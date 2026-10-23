import { Effect, pipe, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { literal, schemaSegment, slash, type Biparser } from "foldkit/route"

/** A URL segment, percent-decoded and re-encoded the way TanStack Router treats `$param`. */
const PercentEncoded = Schema.String.pipe(
	Schema.decodeTo(
		Schema.String,
		SchemaTransformation.transformEffect({
			decode: (raw, options) =>
				Effect.try({
					try: () => decodeURIComponent(raw),
					catch: () =>
						new SchemaIssue.InvalidValue({ message: "malformed percent-encoding" }, raw, options),
				}),
			encode: (value) => Effect.succeed(encodeURIComponent(value)),
		}),
	),
)

/** A decoded path param. Foldkit's `string` keeps the raw segment (`checkout%20api`). */
export const segment = <K extends string>(name: K): Biparser<Record<K, string>> =>
	schemaSegment(name, PercentEncoded)

/** `literal` segments joined by `slash`: `path("infra", "kubernetes")`. */
export const path = (first: string, ...rest: ReadonlyArray<string>): Biparser<{}> =>
	rest.reduce((parser, next) => pipe(parser, slash(literal(next))), literal(first))

/** A decoded path param that must be non-empty and at most `maxLength` long; else the route does not match. */
export const boundedSegment = <K extends string>(name: K, maxLength: number): Biparser<Record<K, string>> =>
	schemaSegment(name, PercentEncoded.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength)))
