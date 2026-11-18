import {
	Array as Arr,
	Effect,
	Option,
	pipe,
	Record,
	Schema,
	SchemaIssue,
	SchemaTransformation,
	String as Str,
} from "effect"
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
	Arr.reduce(rest, literal(first), (parser, next) => pipe(parser, slash(literal(next))))

/** A decoded path param that must be non-empty and at most `maxLength` long; else the route does not match. */
export const boundedSegment = <K extends string>(name: K, maxLength: number): Biparser<Record<K, string>> =>
	schemaSegment(name, PercentEncoded.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength)))

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
						Record.singleton(name, Arr.join(Arr.map(segments, decodeURIComponent), "/")),
						[],
					],
					catch: () => new ParseError({ message: `Malformed percent-encoding in ${name}` }),
				})
			: Effect.fail(new ParseError({ message: `Expected remaining path (${name})` })),
	print: (value, state) =>
		Effect.succeed({
			...state,
			segments: [...state.segments, ...Arr.map(Str.split("/")(value[name]), encodeURIComponent)],
		}),
})

/** {@link restSegments} with the decoded value bounded, for an id an API caps (a user id). */
export const boundedRestSegments = <K extends string>(
	name: K,
	maxLength: number,
): TerminalParser<Record<K, string>> => {
	const rest = restSegments(name)
	return {
		...rest,
		parse: (segments) =>
			rest.parse(segments).pipe(
				Effect.filterOrFail(
					(result) => result[0][name].length <= maxLength,
					() => new ParseError({ message: `${name} is longer than ${maxLength} characters` }),
				),
			),
	}
}

/** A segment that is one of `values`, or absent: `/settings` and `/settings/keys` both match. */
export const optionalLiteralSegment = <V extends string>(
	values: ReadonlyArray<V>,
): Biparser<{ readonly segment?: V }> => ({
	parse: (segments) =>
		Effect.succeed(
			Option.match(
				Arr.findFirst(values, (value) => value === segments[0]),
				{
					onNone: (): ParseResult<{ readonly segment?: V }> => [{}, segments],
					onSome: (segment): ParseResult<{ readonly segment?: V }> => [
						{ segment },
						segments.slice(1),
					],
				},
			),
		),
	print: ({ segment }, state) =>
		Effect.succeed(segment === undefined ? state : { ...state, segments: [...state.segments, segment] }),
})

/** `parser` read and printed through `to` and `from`, for a route whose value is not the URL's shape. */
export const mapBiparser = <A, B>(parser: Biparser<A>, to: (a: A) => B, from: (b: B) => A): Biparser<B> => ({
	parse: (segments, search) =>
		Effect.map(parser.parse(segments, search), ([value, rest]): ParseResult<B> => [to(value), rest]),
	print: (value, state) => parser.print(from(value), state),
})
