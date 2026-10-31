import { Effect, Schema } from "effect"
import { parse as parseToml } from "smol-toml"
import { parse as parseYaml } from "yaml"
import { LockfileParseError } from "../errors.ts"

const parseError = (path: string, what: string) => (cause: unknown) =>
	new LockfileParseError({
		path,
		message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
	})

/** Matches a JSON string literal (kept) or a trailing comma before `]`/`}` (dropped). */
const STRING_OR_TRAILING_COMMA = /"(?:[^"\\]|\\.)*"|,(\s*[\]}])/g

export const stripTrailingCommas = (text: string): string =>
	text.replace(STRING_OR_TRAILING_COMMA, (match: string, closer: string | undefined) => closer ?? match)

export const decodeJson = <T>(
	schema: Schema.Decoder<T>,
	path: string,
	content: string,
): Effect.Effect<T, LockfileParseError> =>
	Schema.decodeEffect(Schema.fromJsonString(schema))(content).pipe(
		Effect.mapError(parseError(path, "invalid JSON lockfile")),
	)

export const decodeUnknown = <T>(
	schema: Schema.Decoder<T>,
	path: string,
	input: unknown,
): Effect.Effect<T, LockfileParseError> =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(parseError(path, "unexpected lockfile shape")),
	)

export const parseYamlText = (path: string, content: string): Effect.Effect<unknown, LockfileParseError> =>
	Effect.try({
		// The library's alias cap stops a lockfile of nested anchors from expanding past memory.
		try: () => parseYaml(content),
		catch: parseError(path, "invalid YAML"),
	})

export const parseTomlText = (path: string, content: string): Effect.Effect<unknown, LockfileParseError> =>
	Effect.try({ try: () => parseToml(content), catch: parseError(path, "invalid TOML") })
