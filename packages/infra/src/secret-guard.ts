// Holds every deploy to the catalog. A secret resolves only for a deployable the catalog grants it
// to, enforced where the value is read (the `ConfigProvider`), so it covers Workers and ECS alike.
import {
	Array as Arr,
	Config,
	ConfigProvider,
	Context,
	Effect,
	Option,
	Record as Rec,
	Redacted,
} from "effect"
import { Stage } from "alchemy/Stage"
import { type MapleDeployment, parseMapleDeploymentEffect } from "./cloudflare/stage.ts"
import type { MapleRegion } from "./region.ts"
import type { SecretConsumer, SecretEnvironment } from "./secret.ts"
import * as Catalog from "./secrets.ts"

const secrets = Rec.values(Catalog)
const bySourceKey = new Map<string, (typeof secrets)[number]>(
	Arr.map(secrets, (secret) => [secret.envKey, secret]),
)
const boundNames = new Set(Arr.map(secrets, (secret) => secret.boundAs))

/** The deployable resolving config on this fiber. None outside a deployable's scope. */
const CurrentSecretConsumer = Context.Reference<Option.Option<SecretConsumer>>(
	"@maple/infra/CurrentSecretConsumer",
	{ defaultValue: () => Option.none() },
)

const CATALOG_PATH = "packages/infra/src/secrets.ts"

const refusal = (message: string) => new ConfigProvider.SourceError({ message })

/**
 * Default-deny over the catalog: one of its keys loads only for a consumer the secret lists. The
 * whole path names the key, since an env-backed provider resolves `["A", "B"]` as `A_B`.
 */
const guard = (provider: ConfigProvider.ConfigProvider): ConfigProvider.ConfigProvider =>
	ConfigProvider.make((path) =>
		Effect.gen(function* () {
			const secret = bySourceKey.get(Arr.join(Arr.map(path, String), "_"))
			if (secret === undefined) return yield* provider.load(path)
			const consumer = yield* CurrentSecretConsumer
			if (Option.isNone(consumer)) {
				return yield* refusal(
					`${secret.envKey} was read outside a deployable's scope. Resolve it through resolveAs or resolveWorkerEnv (@maple/infra/secret-guard).`,
				)
			}
			if (!secret.meta.consumers.includes(consumer.value)) {
				return yield* refusal(
					`${consumer.value} may not read ${secret.envKey}: ${CATALOG_PATH} does not list it as a consumer.`,
				)
			}
			return yield* provider.load(path)
		}),
	)

const PRD_ENVIRONMENT = { us: "prod", eu: "prod-eu" } satisfies Record<MapleRegion, SecretEnvironment>

/** The Infisical environment a deployment loads its config from. */
export const secretEnvironment = ({ stage, region }: MapleDeployment): SecretEnvironment => {
	switch (stage.kind) {
		case "prd":
			return PRD_ENVIRONMENT[region]
		case "pr":
			return "preview"
		case "dev":
			return "dev"
	}
}

/** Fails when `environment` holds a secret the catalog keeps out of it. Blank counts as unset. */
const refuseMisplaced = (environment: SecretEnvironment) =>
	Effect.gen(function* () {
		const provider = yield* ConfigProvider.ConfigProvider
		const held = yield* Effect.filter(
			Arr.filter(secrets, (secret) => !(secret.meta.environments?.includes(environment) ?? true)),
			(secret) => secret.optionalValue.parse(provider).pipe(Effect.map(Option.isSome)),
		)
		if (Arr.isReadonlyArrayNonEmpty(held)) {
			const keys = Arr.join(
				Arr.map(held, (secret) => secret.envKey),
				", ",
			)
			return yield* Effect.fail(
				new Config.ConfigError(
					refusal(
						`The ${environment} environment holds ${keys}, which ${CATALOG_PATH} keeps out of it. Remove it there.`,
					),
				),
			)
		}
	})

/**
 * Run `effect` with the catalog guarding its config. Around the whole stack, a secret read outside
 * any deployable's scope (a Worker's init included) fails the deploy instead of going unchecked, as
 * does a secret the stage's environment may not hold.
 */
export const withSecretGuard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const stage = yield* Stage
		// `Alchemy.Stack` admits only `ConfigError`.
		const deployment = yield* parseMapleDeploymentEffect(stage).pipe(
			Effect.mapError((error) => new Config.ConfigError(refusal(error.message))),
		)
		yield* refuseMisplaced(secretEnvironment(deployment))
		return yield* effect.pipe(Effect.updateService(ConfigProvider.ConfigProvider, guard))
	})

/** Resolve `config` as `consumer`: the only way a deploy reads a catalog secret. */
export const resolveAs = <A>(consumer: SecretConsumer, config: Config.Config<A>) =>
	Effect.gen(function* () {
		const provider = yield* ConfigProvider.ConfigProvider
		return yield* config.parse(guard(provider))
	}).pipe(Effect.provideService(CurrentSecretConsumer, Option.some(consumer)))

/**
 * A Worker's config-sourced env, resolved as `consumer`. Also refuses a catalog secret read as a
 * plain value, which would make it a plain-text var on the Worker. By bound name only: one bound
 * under another name is not seen.
 */
export const resolveWorkerEnv = <A extends Record<string, unknown>>(
	consumer: SecretConsumer,
	config: Config.Config<A>,
) =>
	Effect.gen(function* () {
		const env = yield* resolveAs(consumer, config)
		const plainText = Arr.filter(
			Rec.keys(env),
			(name) => boundNames.has(name) && !Redacted.isRedacted(env[name]),
		)
		if (Arr.isReadonlyArrayNonEmpty(plainText)) {
			return yield* Effect.fail(
				new Config.ConfigError(
					refusal(
						`${consumer} would bind ${Arr.join(plainText, ", ")} as plain text. Bind it through its class in ${CATALOG_PATH}.`,
					),
				),
			)
		}
		return env
	})
