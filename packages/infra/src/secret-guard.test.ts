import {
	Array as Arr,
	Config,
	ConfigProvider,
	Effect,
	Exit,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	Schema,
} from "effect"
import { assert, describe, expect, it } from "vitest"
import { resolveAs, resolveWorkerEnv, withSecretGuard } from "./secret-guard.ts"
import * as Catalog from "./secrets.ts"
import { OpenRouterApiKey, OtelIngestKey, StripeSecretKey } from "./secrets.ts"

type Env = Record<string, string>

/** Run a deploy-side effect against `env`, through the env-backed provider a deploy reads. */
const run = <A, E>(effect: Effect.Effect<A, E>, env: Env) =>
	Effect.runSync(
		Effect.exit(
			Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
		),
	)

/** Why a deploy-side effect failed: the `ConfigError`'s cause and its message. */
const failure = <A>(effect: Effect.Effect<A, Config.ConfigError>, env: Env) => {
	const exit = run(Effect.flip(effect), env)
	assert(Exit.isSuccess(exit), "expected the deploy to be refused")
	return { cause: exit.value.cause._tag, message: exit.value.message }
}

const reveal = (env: Record<string, unknown>) =>
	Rec.map(env, (value) => (Redacted.isRedacted(value) ? Redacted.value(value) : value))

const STRIPE = { STRIPE_SECRET_KEY: "sk_test_1" }
const NOT_GRANTED = "landing may not read STRIPE_SECRET_KEY"
const NO_SCOPE = "STRIPE_SECRET_KEY was read outside a deployable's scope"

describe("the catalog", () => {
	it("declares each source key and each bound name once", () => {
		const secrets = Rec.values(Catalog)
		expect(new Set(Arr.map(secrets, (secret) => secret.envKey)).size).toBe(secrets.length)
		expect(new Set(Arr.map(secrets, (secret) => secret.boundAs)).size).toBe(secrets.length)
	})
})

describe("a secret's deploy bindings", () => {
	it("binds a set value trimmed, and omits an unset or blank one", () => {
		const set = run(resolveAs("api", StripeSecretKey.optional), { STRIPE_SECRET_KEY: " sk_test_1 " })
		assert(Exit.isSuccess(set))
		expect(reveal(set.value)).toEqual({ STRIPE_SECRET_KEY: "sk_test_1" })

		const blank = run(resolveAs("api", StripeSecretKey.optional), { STRIPE_SECRET_KEY: "  " })
		assert(Exit.isSuccess(blank))
		expect(blank.value).toEqual({})
	})

	it("fails the deploy when a required value is missing, as a missing value and not a refusal", () => {
		expect(failure(resolveAs("api", StripeSecretKey.required), {}).cause).toBe("SchemaError")
	})

	it("binds under the name the Worker reads, not the source key", () => {
		const exit = run(resolveAs("web", OtelIngestKey.required), { MAPLE_OTEL_INGEST_KEY: "maple_pk_1" })
		assert(Exit.isSuccess(exit))
		expect(reveal(exit.value)).toEqual({ MAPLE_INGEST_KEY: "maple_pk_1" })
	})

	it("hands the bare value to a deployable that stores it elsewhere", () => {
		const exit = run(resolveAs("scraper", OtelIngestKey.requiredValue), {
			MAPLE_OTEL_INGEST_KEY: "maple_pk_1",
		})
		assert(Exit.isSuccess(exit))
		expect(Redacted.value(exit.value)).toBe("maple_pk_1")

		const unset = run(resolveAs("scraper", OtelIngestKey.optionalValue), {})
		assert(Exit.isSuccess(unset))
		expect(unset.value).toEqual(Option.none())
	})
})

describe("the catalog as a default-deny guard", () => {
	it("resolves a secret for a deployable the catalog grants it to", () => {
		const exit = run(resolveAs("api", StripeSecretKey.required), STRIPE)
		assert(Exit.isSuccess(exit))
		expect(reveal(exit.value)).toEqual(STRIPE)
	})

	it("refuses a deployable the catalog does not grant it to, even an optional read", () => {
		expect(failure(resolveAs("landing", StripeSecretKey.required), STRIPE).message).toContain(NOT_GRANTED)
		expect(failure(resolveAs("landing", StripeSecretKey.optional), STRIPE).message).toContain(NOT_GRANTED)
	})

	it("refuses the same key read by name, so a plain read is no way around it", () => {
		const byName = Config.option(Config.String("STRIPE_SECRET_KEY"))
		expect(failure(resolveAs("landing", byName), STRIPE).message).toContain(NOT_GRANTED)
	})

	const splitReads: ReadonlyArray<readonly [string, Config.Config<unknown>]> = [
		["a nested key", Config.String("KEY").pipe(Config.nested("STRIPE_SECRET"))],
		["path segments", Config.schema(Schema.String, ["STRIPE", "SECRET", "KEY"])],
		["a struct field", Config.schema(Schema.Struct({ KEY: Schema.String }), ["STRIPE", "SECRET"])],
	]

	it.each(splitReads)(
		"guards the same key read as %s, which an env-backed provider joins back",
		(_, split) => {
			// Granted, the split path does reach the secret, so the refusal below is the guard's.
			expect(Exit.isSuccess(run(resolveAs("api", split), STRIPE))).toBe(true)
			expect(failure(resolveAs("landing", split), STRIPE).message).toContain(NOT_GRANTED)
		},
	)

	it("refuses a secret read outside any deployable's scope once the stack is guarded", () => {
		// How a stack file reads config inline, with no deployable named.
		const unscoped = Effect.gen(function* () {
			const bound = yield* StripeSecretKey.optional
			return reveal(bound)
		})
		expect(failure(withSecretGuard(unscoped), STRIPE).message).toContain(NO_SCOPE)
	})

	it("still resolves a granted secret inside a guarded stack", () => {
		const exit = run(withSecretGuard(resolveAs("api", StripeSecretKey.required)), STRIPE)
		assert(Exit.isSuccess(exit))
		expect(reveal(exit.value)).toEqual(STRIPE)
	})

	it("leaves config that is not a secret alone, with no deployable named", () => {
		const plain = Effect.gen(function* () {
			const provider = yield* Config.String("MAPLE_LLM_PROVIDER")
			return { provider }
		})
		const exit = run(withSecretGuard(plain), { MAPLE_LLM_PROVIDER: "openrouter" })
		assert(Exit.isSuccess(exit))
		expect(exit.value).toEqual({ provider: "openrouter" })
	})
})

describe("where a secret may be held", () => {
	const WEBHOOK_SECRET = { CLERK_WEBHOOK_SECRET: "whsec_1" }
	const deploy = (env: Env) => run(withSecretGuard(Effect.void), env)

	it("fails a deploy whose loaded environment holds a secret the catalog keeps out of it", () => {
		const refused = failure(withSecretGuard(Effect.void), {
			...WEBHOOK_SECRET,
			INFISICAL_ENV_SLUG: "preview",
		})
		expect(refused.cause).toBe("SourceError")
		expect(refused.message).toContain("The preview environment holds CLERK_WEBHOOK_SECRET")
	})

	it("deploys where the catalog allows it, a blank value anywhere, and with no environment named", () => {
		expect(Exit.isSuccess(deploy({ ...WEBHOOK_SECRET, INFISICAL_ENV_SLUG: "dev" }))).toBe(true)
		expect(Exit.isSuccess(deploy({ CLERK_WEBHOOK_SECRET: " ", INFISICAL_ENV_SLUG: "preview" }))).toBe(
			true,
		)
		// A local `bun dev`, on `.env.local`.
		expect(Exit.isSuccess(deploy(WEBHOOK_SECRET))).toBe(true)
	})

	it("refuses an environment the catalog does not know", () => {
		expect(Exit.isFailure(deploy({ INFISICAL_ENV_SLUG: "staging" }))).toBe(true)
	})
})

describe("a Worker's resolved env", () => {
	const env = { OPENROUTER_API_KEY: "sk-or-1" }

	it("refuses a catalog secret that would be bound as a plain-text var", () => {
		const asPlainText = Config.String("OPENROUTER_API_KEY").pipe(
			Config.map((value) => ({ OPENROUTER_API_KEY: value })),
		)
		expect(failure(resolveWorkerEnv("ai", asPlainText), env).message).toContain(
			"ai would bind OPENROUTER_API_KEY as plain text",
		)
	})

	it("accepts the same secret bound through its class", () => {
		const exit = run(resolveWorkerEnv("ai", OpenRouterApiKey.required), env)
		assert(Exit.isSuccess(exit))
		expect(reveal(exit.value)).toEqual(env)
	})
})

describe("a secret at runtime", () => {
	/** The Worker's env as its `ConfigProvider`, the way `workerEnvLayer` provides it. */
	const workerEnv = (env: Env) => Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
	const stripeKey = (env: Env) =>
		Effect.runSync(
			StripeSecretKey.useSync((bound) => bound).pipe(
				Effect.provide(StripeSecretKey.layer.pipe(workerEnv(env))),
			),
		)
	const otelKey = (env: Env) =>
		Effect.runSync(
			OtelIngestKey.useSync((bound) => bound).pipe(
				Effect.provide(OtelIngestKey.layer.pipe(workerEnv(env))),
			),
		)

	it("is the bound value, and absent when the Worker was not given one", () => {
		expect(Option.map(stripeKey(STRIPE), Redacted.value)).toEqual(Option.some("sk_test_1"))
		expect(stripeKey({})).toEqual(Option.none())
	})

	it("is read under the name the deploy bound it as, not its source key", () => {
		expect(Option.map(otelKey({ MAPLE_INGEST_KEY: "maple_pk_1" }), Redacted.value)).toEqual(
			Option.some("maple_pk_1"),
		)
		expect(otelKey({ MAPLE_OTEL_INGEST_KEY: "maple_pk_1" })).toEqual(Option.none())
	})

	it("carries its name, so a log line says which secret it was", () => {
		expect(Option.getOrThrow(stripeKey(STRIPE)).label).toBe("STRIPE_SECRET_KEY")
	})
})
