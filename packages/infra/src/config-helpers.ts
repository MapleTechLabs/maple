// Small effect `Config` helpers shared by worker env schemas (apps/api's `Env`,
// apps/electric-sync's `SyncConfig`). Kept in a standalone module — NOT the
// package index, whose deploy-side graph (alchemy, portless) has no business in
// a Worker bundle or a test. This module imports only `effect`, so it's safe
// everywhere.
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
