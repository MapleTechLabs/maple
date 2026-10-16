// `Config` helpers for runtime Worker env schemas. Imports only `effect`; keep it out of the
// package index, which pulls in deploy-side deps.
import { Config, Option, Redacted } from "effect"

/** `Config.String(key)` with a fallback when the env var is unset. */
export const stringWithDefault = (key: string, fallback: string) =>
	Config.String(key).pipe(Config.withDefault(fallback))

/** Optional string; treats a blank/whitespace-only value as absent (`None`). */
export const optionalString = (key: string) =>
	Config.option(Config.String(key)).pipe(
		Config.map((opt) =>
			Option.flatMap(opt, (s) => (s.trim().length > 0 ? Option.some(s) : Option.none())),
		),
	)

/** Optional redacted secret; treats a blank/whitespace-only value as absent (`None`). */
export const optionalRedacted = (key: string) =>
	Config.option(Config.String(key)).pipe(
		Config.map((opt) =>
			Option.flatMap(opt, (s) => (s.trim().length > 0 ? Option.some(Redacted.make(s)) : Option.none())),
		),
	)
