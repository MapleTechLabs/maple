// One declaration per deployment secret: its env key, who issues it and which deployables may
// bind it. Stays free of deploy-side imports, so the runtime reads the declaration the deploy binds.
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { requiredTrimmed, trimmedOption } from "./config-helpers.ts"

/**
 * Everything a deploy hands a secret to: the Workers, the three ECS services, the site build, the
 * account's Workers Observability destinations and the dev stages' managed Hyperdrive config.
 */
export type SecretConsumer =
	| "api"
	| "ai"
	| "alerting"
	| "chat-bot"
	| "electric-sync"
	| "sandbox"
	| "status"
	| "web"
	| "landing"
	| "ingest"
	| "scraper"
	| "electric"
	| "workers-observability"
	| "managed-db"

interface SecretMeta {
	/** Who mints the value. `maple` means we generate it, so we can roll it without a third party. */
	readonly issuer: string
	/** The deployables allowed to bind it. Widening access is a change to this list. */
	readonly consumers: ReadonlyArray<SecretConsumer>
	/** The env name the Worker reads it under, when that differs from the source key. */
	readonly boundAs?: string
}

export type SecretBinding = Record<string, Redacted.Redacted>

/**
 * A secret as a class. At deploy, `X.required` / `X.optional` bind it into a Worker env and
 * `X.requiredValue` / `X.optionalValue` hand over the bare value. At runtime `yield* X` reads it.
 * `X.layer` belongs in the graph built on the first request, never in Worker init (docs/infra.md).
 */
export const Secret =
	<Self>() =>
	<const Key extends string>(key: Key, meta: SecretMeta) => {
		const boundAs = meta.boundAs ?? key
		const requiredValue = requiredTrimmed(key).pipe(Config.map((value) => Redacted.make(value)))
		const optionalValue = trimmedOption(key).pipe(Config.map(Option.map((value) => Redacted.make(value))))
		return class extends Context.Service<Self, Option.Option<Redacted.Redacted>>()(
			`@maple/infra/Secret/${key}`,
		) {
			static readonly envKey: Key = key
			static readonly boundAs: string = boundAs
			static readonly meta: SecretMeta = meta
			/** Deploy: the value, for a deployable that stores it elsewhere (an ECS task's secrets). */
			static readonly requiredValue: Config.Config<Redacted.Redacted> = requiredValue
			/** Deploy: {@link requiredValue}, absent when unset or blank. */
			static readonly optionalValue: Config.Config<Option.Option<Redacted.Redacted>> = optionalValue
			/** Deploy: a Worker env entry; a missing value fails the deploy with a `ConfigError`. */
			static readonly required: Config.Config<SecretBinding> = requiredValue.pipe(
				Config.map((value): SecretBinding => ({ [boundAs]: value })),
			)
			/** Deploy: a Worker env entry, omitted when unset or blank. */
			static readonly optional: Config.Config<SecretBinding> = optionalValue.pipe(
				Config.map(
					Option.match({
						onNone: (): SecretBinding => ({}),
						onSome: (value): SecretBinding => ({ [boundAs]: value }),
					}),
				),
			)
			/** Runtime: the value this deployable was bound, labelled so a log line names it. */
			static readonly layer = Layer.effect(
				this,
				Effect.gen(function* () {
					const value = yield* trimmedOption(boundAs)
					return Option.map(value, (raw) => Redacted.make(raw, { label: boundAs }))
				}),
			)
		}
	}
