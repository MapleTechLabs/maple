// One declaration per deployment secret: its env key, who issues it and which deployables may
// bind it. Imports only `effect`, so the runtime reads the declaration the deploy binds from.
import { Config, Context, Effect, Layer, Option, Redacted, Schema, String as Str } from "effect"
import { optionalString } from "./config-helpers.ts"

/**
 * Everything a deploy hands a secret to: the Workers, the three ECS services, the site build, the
 * account's Workers Observability destinations and the dev stages' managed Hyperdrive config.
 */
const SECRET_CONSUMERS = [
	"api",
	"ai",
	"alerting",
	"chat-bot",
	"electric-sync",
	"sandbox",
	"status",
	"web",
	"landing",
	"ingest",
	"scraper",
	"electric",
	"workers-observability",
	"managed-db",
] as const
export type SecretConsumer = (typeof SECRET_CONSUMERS)[number]

export interface SecretMeta {
	/** Who mints the value. `maple` means we generate it, so we can roll it without a third party. */
	readonly issuer: string
	/** The deployables allowed to bind it. Widening access is a change to this list. */
	readonly consumers: ReadonlyArray<SecretConsumer>
	/** The env name the Worker reads it under, when that differs from the source key. */
	readonly boundAs?: string
	/** Each consumer reads its own `<CONSUMER>_<KEY>` at deploy; the bound name stays unprefixed. */
	readonly perConsumer?: boolean
}

export type SecretBinding = Record<string, Redacted.Redacted>

/** What the guard and the catalog listing read off a secret class. */
export interface AnySecret {
	readonly envKey: string
	readonly boundAs: string
	readonly meta: SecretMeta
}

/** Present-and-non-blank, trimmed. A blank var is an unset one, as in `@maple/infra/env`. */
const present = (key: string): Config.Config<Option.Option<string>> =>
	optionalString(key).pipe(Config.map((value) => Option.map(value, (raw) => Str.trim(raw))))

const required = (key: string): Config.Config<string> =>
	Config.schema(Schema.Trim.check(Schema.isNonEmpty()), key)

/**
 * A secret as a class: `X.required` / `X.optional` bind it at deploy, `yield* X` reads it in a
 * service, so a layer's requirements name the secrets it uses. `X.layer` belongs in the graph built
 * on the first request (docs/infra.md): read in init, alchemy would auto-bind it at plan time.
 * Deploy reads resolve only inside a deployable's scope (`resolveAs` in `secret-guard.ts`).
 */
export const Secret =
	<Self>() =>
	<const Key extends string>(key: Key, meta: SecretMeta) => {
		const boundAs = meta.boundAs ?? key
		return class extends Context.Service<Self, Option.Option<Redacted.Redacted>>()(
			`@maple/infra/Secret/${key}`,
		) {
			static readonly envKey: Key = key
			static readonly boundAs: string = boundAs
			static readonly meta: SecretMeta = meta
			/** Deploy: the value itself, for a deployable that stores it elsewhere (an ECS task's secrets). */
			static readonly value: Config.Config<Redacted.Redacted> = required(key).pipe(
				Config.map((value) => Redacted.make(value)),
			)
			/** Deploy: {@link value}, absent when unset. */
			static readonly valueOption: Config.Config<Option.Option<Redacted.Redacted>> = present(key).pipe(
				Config.map(Option.map((value) => Redacted.make(value))),
			)
			/** Deploy: bound when set, omitted when not. */
			static readonly optional: Config.Config<SecretBinding> = present(key).pipe(
				Config.map(
					Option.match({
						onNone: (): SecretBinding => ({}),
						onSome: (value): SecretBinding => ({ [boundAs]: Redacted.make(value) }),
					}),
				),
			)
			/** Deploy: a missing value fails the deploy with a `ConfigError`. */
			static readonly required: Config.Config<SecretBinding> = required(key).pipe(
				Config.map((value): SecretBinding => ({ [boundAs]: Redacted.make(value) })),
			)
			/** Runtime: the value this deployable was bound, labelled so a log line names it. */
			static readonly layer = Layer.effect(
				this,
				Effect.gen(function* () {
					const value = yield* present(boundAs)
					return Option.map(value, (raw) => Redacted.make(raw, { label: boundAs }))
				}),
			)
		}
	}
