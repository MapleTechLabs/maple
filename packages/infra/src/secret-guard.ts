// Holds every deploy to the catalog. A secret resolves only for a deployable the catalog grants it
// to, enforced where the value is read (the `ConfigProvider`), so it covers Workers and ECS alike.
// Imports only `effect` and the catalog.
import {
	Array as Arr,
	Config,
	ConfigProvider,
	Context,
	Effect,
	Option,
	Order,
	Record as Rec,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import type { AnySecret, SecretConsumer } from "./secret.ts"
import * as Catalog from "./secrets.ts"

/** Every declared secret: the catalog module's exports. */
const ALL_SECRETS: ReadonlyArray<AnySecret> = Rec.values(Catalog)

/** Where each source key and each bound name is declared; more than one class is a catalog mistake. */
export const catalogCollisions = (): ReadonlyArray<string> => {
	const repeated = (names: ReadonlyArray<string>) =>
		Arr.dedupe(Arr.filter(names, (name, index) => names.indexOf(name) !== index))
	return [
		...repeated(Arr.map(ALL_SECRETS, (secret) => secret.envKey)),
		...repeated(Arr.map(ALL_SECRETS, (secret) => secret.boundAs)),
	]
}

/** The secrets the catalog grants `consumer`, by source key, sorted. */
export const grantedTo = (consumer: SecretConsumer): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(
			Arr.filter(ALL_SECRETS, (secret) => secret.meta.consumers.includes(consumer)),
			(secret) => secret.envKey,
		),
		Order.String,
	)

/** The deployable resolving config on this fiber. None outside a deployable's scope. */
export const CurrentSecretConsumer = Context.Reference<Option.Option<SecretConsumer>>(
	"@maple/infra/CurrentSecretConsumer",
	{ defaultValue: () => Option.none() },
)

const CATALOG_PATH = "packages/infra/src/secrets.ts"

const denied = (message: string) => Effect.fail(new ConfigProvider.SourceError({ message }))

/**
 * Default-deny over `secrets`: one of their keys loads only for a consumer the secret lists, and a
 * per-consumer secret loads from `<CONSUMER>_<KEY>`. Every other key passes through untouched.
 */
export const guardWith =
	(secrets: ReadonlyArray<AnySecret>) =>
	(provider: ConfigProvider.ConfigProvider): ConfigProvider.ConfigProvider => {
		const bySourceKey = new Map(Arr.map(secrets, (secret) => [secret.envKey, secret] as const))
		return ConfigProvider.make((path) =>
			Effect.gen(function* () {
				const [head, ...rest] = path
				const secret = typeof head === "string" ? bySourceKey.get(head) : undefined
				if (secret === undefined) return yield* provider.load(path)
				const consumer = yield* CurrentSecretConsumer
				if (Option.isNone(consumer)) {
					return yield* denied(
						`${secret.envKey} was read outside a deployable's scope. Resolve it through resolveAs or resolveWorkerEnv (@maple/infra/secret-guard).`,
					)
				}
				if (!secret.meta.consumers.includes(consumer.value)) {
					return yield* denied(
						`${consumer.value} may not read ${secret.envKey}: ${CATALOG_PATH} does not list it as a consumer.`,
					)
				}
				return yield* provider.load(
					secret.meta.perConsumer === true
						? [
								`${Str.replaceAll("-", "_")(Str.toUpperCase(consumer.value))}_${secret.envKey}`,
								...rest,
							]
						: path,
				)
			}),
		)
	}

/** {@link guardWith} over the catalog. */
const guardSecrets = guardWith(ALL_SECRETS)

/**
 * Run `effect` with the catalog guarding its config. At the stack root this makes a secret read
 * outside any deployable's scope a deploy failure instead of an unchecked read.
 */
export const withSecretGuard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const provider = yield* ConfigProvider.ConfigProvider
		return yield* Effect.provideService(effect, ConfigProvider.ConfigProvider, guardSecrets(provider))
	})

/** Resolve `config` as `consumer`: the only way a deploy reads a catalog secret. */
export const resolveAs = <A>(consumer: SecretConsumer, config: Config.Config<A>) =>
	Effect.gen(function* () {
		const provider = yield* ConfigProvider.ConfigProvider
		return yield* config.parse(guardSecrets(provider))
	}).pipe(Effect.provideService(CurrentSecretConsumer, Option.some(consumer)))

const EnvViolation = Schema.Struct({
	name: Schema.String,
	reason: Schema.Literals(["undeclared-secret", "secret-bound-as-plain-text"]),
})
type EnvViolation = typeof EnvViolation.Type

export class WorkerEnvSecretError extends Schema.TaggedError<WorkerEnvSecretError>()(
	"@maple/infra/WorkerEnvSecretError",
	{
		message: Schema.String,
		consumer: Schema.String,
		violations: Schema.Array(EnvViolation),
	},
) {}

const boundNames = new Set(Arr.map(ALL_SECRETS, (secret) => secret.boundAs))
const sourceKeys = new Set(Arr.map(ALL_SECRETS, (secret) => secret.envKey))

/**
 * What a resolved Worker env holds that the read guard cannot see: a secret no registry declares
 * (built by hand from a plain read), or a catalog secret that ended up as a plain-text var.
 * `alsoDeclared` names secrets a second registry owns (the chat connectors' config keys).
 */
const auditWorkerEnv = (
	env: Record<string, unknown>,
	alsoDeclared: ReadonlyArray<string> = [],
): ReadonlyArray<EnvViolation> =>
	Arr.flatMap(Rec.toEntries(env), ([name, value]): ReadonlyArray<EnvViolation> => {
		const declared = boundNames.has(name)
		if (Redacted.isRedacted(value)) {
			return declared || alsoDeclared.includes(name) ? [] : [{ name, reason: "undeclared-secret" }]
		}
		return declared && typeof value === "string" ? [{ name, reason: "secret-bound-as-plain-text" }] : []
	})

/**
 * A Worker's config-sourced env, resolved as `consumer` and audited. Worker props may only fail
 * with a `ConfigError`, so an audit failure is one, caused by a `WorkerEnvSecretError`.
 */
export const resolveWorkerEnv = <A extends Record<string, unknown>>(
	consumer: SecretConsumer,
	config: Config.Config<A>,
	alsoDeclared: ReadonlyArray<string> = [],
) =>
	Effect.gen(function* () {
		const env = yield* resolveAs(consumer, config)
		const violations = auditWorkerEnv(env, alsoDeclared)
		if (Arr.isReadonlyArrayNonEmpty(violations)) {
			const cause = new WorkerEnvSecretError({
				message: `${consumer} binds secrets ${CATALOG_PATH} does not cover: ${Arr.join(
					Arr.map(violations, (violation) => `${violation.name} (${violation.reason})`),
					", ",
				)}`,
				consumer,
				violations,
			})
			return yield* Effect.fail(
				new Config.ConfigError(new ConfigProvider.SourceError({ message: cause.message, cause })),
			)
		}
		return env
	})

/**
 * The catalog secrets `config` reads as `consumer`, with every key answered, sorted. For the test
 * that holds a deployable's grants exact: it fails on a read the catalog denies, and its result is
 * compared with {@link grantedTo}.
 */
export const secretsReadBy = <A>(consumer: SecretConsumer, config: Config.Config<A>) =>
	Effect.gen(function* () {
		const read = new Set<string>()
		const everything = ConfigProvider.make(() => Effect.succeed(ConfigProvider.makeValue("x")))
		const recording = ConfigProvider.make((path) => {
			const [head] = path
			if (typeof head === "string" && sourceKeys.has(head)) read.add(head)
			return guardSecrets(everything).load(path)
		})
		yield* config.parse(recording)
		return Arr.sort(Arr.fromIterable(read), Order.String)
	}).pipe(Effect.provideService(CurrentSecretConsumer, Option.some(consumer)))
