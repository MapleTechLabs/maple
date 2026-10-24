import { Array as Arr, Effect, pipe, Record, Schema, SchemaIssue, SchemaTransformation } from "effect"
import {
	literal,
	ParseError,
	schemaSegment,
	slash,
	type Biparser,
	type ParseResult,
	type TerminalParser,
} from "foldkit/route"

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

/**
 * The rest of the path as one decoded value with its slashes (`app/prod-alb/50dc…`). Cloudflare
 * turns an encoded `%2F` into a real slash before the page loads, so such a value can't be one segment.
 */
export const restSegments = <K extends string>(name: K): TerminalParser<Record<K, string>> => ({
	__terminal: true,
	parse: (segments) =>
		Arr.isReadonlyArrayNonEmpty(segments)
			? Effect.try({
					try: (): ParseResult<Record<K, string>> => [
						Record.singleton(name, segments.map(decodeURIComponent).join("/")),
						[],
					],
					catch: () => new ParseError({ message: `Malformed percent-encoding in ${name}` }),
				})
			: Effect.fail(new ParseError({ message: `Expected remaining path (${name})` })),
	print: (value, state) =>
		Effect.succeed({
			...state,
			segments: [...state.segments, ...value[name].split("/").map(encodeURIComponent)],
		}),
})
