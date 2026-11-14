// `Config` helpers for runtime Worker env schemas. Imports only `effect`; keep it out of the
// package index, which pulls in deploy-side deps.
import { Config, Option, Redacted, Schema, String as Str } from "effect"

/** `Config.String(key)` with a fallback when the env var is unset. */
export const stringWithDefault = (key: string, fallback: string) =>
	Config.String(key).pipe(Config.withDefault(fallback))

/** Optional string; treats a blank/whitespace-only value as absent (`None`). */
export const optionalString = (key: string) =>
	Config.option(Config.String(key)).pipe(
		Config.map((opt) =>
			Option.flatMap(opt, (s) => (Str.trim(s).length > 0 ? Option.some(s) : Option.none())),
		),
	)

/** Present-and-non-blank, trimmed (`optionalString` returns the raw value). */
export const trimmedOption = (key: string): Config.Config<Option.Option<string>> =>
	optionalString(key).pipe(Config.map((value) => Option.map(value, (raw) => Str.trim(raw))))

/** Required value, trimmed; blank fails with a `ConfigError`. */
export const requiredTrimmed = (key: string): Config.Config<string> =>
	Config.schema(Schema.Trim.check(Schema.isNonEmpty()), key)

/** Optional redacted secret; treats a blank/whitespace-only value as absent (`None`). */
export const optionalRedacted = (key: string) =>
	Config.option(Config.String(key)).pipe(
		Config.map((opt) =>
			Option.flatMap(opt, (s) =>
				Str.trim(s).length > 0 ? Option.some(Redacted.make(s)) : Option.none(),
			),
		),
	)
