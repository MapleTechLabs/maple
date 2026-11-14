import { Config, ConfigProvider, Effect, Exit, Layer, Option, Record as Rec, Redacted } from "effect"
import { assert, describe, expect, it } from "vitest"
import { Secret, type SecretConsumer } from "./secret.ts"
import {
	catalogCollisions,
	CurrentSecretConsumer,
	guardWith,
	resolveAs,
	resolveWorkerEnv,
	secretsReadBy,
	withSecretGuard,
} from "./secret-guard.ts"
import { OpenRouterApiKey, OtelIngestKey, StripeSecretKey } from "./secrets.ts"

type Env = Record<string, string>

/** Run a deploy-side effect against `env`, as the stack would against its `.env`. */
const run = <A, E>(effect: Effect.Effect<A, E>, env: Env) =>
	Effect.runSync(
		Effect.exit(
			Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
		),
	)

const reveal = (env: Record<string, unknown>) =>
	Rec.map(env, (value) => (Redacted.isRedacted(value) ? Redacted.value(value) : value))

const STRIPE = { STRIPE_SECRET_KEY: "sk_test_1" }

describe("the catalog", () => {
	it("declares each source key and each bound name once", () => {
		expect(catalogCollisions()).toEqual([])
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

	it("fails the deploy when a required value is missing", () => {
		expect(Exit.isFailure(run(resolveAs("api", StripeSecretKey.required), {}))).toBe(true)
	})

	it("binds under the name the Worker reads, not the source key", () => {
		const exit = run(resolveAs("web", OtelIngestKey.required), { MAPLE_OTEL_INGEST_KEY: "maple_pk_1" })
		assert(Exit.isSuccess(exit))
		expect(reveal(exit.value)).toEqual({ MAPLE_INGEST_KEY: "maple_pk_1" })
	})

	it("hands the bare value to a deployable that stores it elsewhere", () => {
		const exit = run(resolveAs("scraper", OtelIngestKey.value), { MAPLE_OTEL_INGEST_KEY: "maple_pk_1" })
		assert(Exit.isSuccess(exit))
		expect(Redacted.value(exit.value)).toBe("maple_pk_1")

		const unset = run(resolveAs("scraper", OtelIngestKey.valueOption), {})
		assert(Exit.isSuccess(unset))
		expect(unset.value).toEqual(Option.none())
	})
})

describe("the catalog as a default-deny guard", () => {
	it("resolves a secret for a deployable the catalog grants it to", () => {
		expect(Exit.isSuccess(run(resolveAs("api", StripeSecretKey.required), STRIPE))).toBe(true)
	})

	it("refuses a deployable the catalog does not grant it to, even an optional read", () => {
		expect(Exit.isFailure(run(resolveAs("landing", StripeSecretKey.required), STRIPE))).toBe(true)
		expect(Exit.isFailure(run(resolveAs("landing", StripeSecretKey.optional), STRIPE))).toBe(true)
	})

	it("refuses the same key read by name, so a plain read is no way around it", () => {
		expect(Exit.isFailure(run(resolveAs("landing", Config.String("STRIPE_SECRET_KEY")), STRIPE))).toBe(
			true,
		)
		expect(
			Exit.isFailure(
				run(resolveAs("landing", Config.option(Config.String("STRIPE_SECRET_KEY"))), STRIPE),
			),
		).toBe(true)
	})

	it("refuses a secret read outside any deployable's scope once the stack is guarded", () => {
		// How a stack file reads config inline, with no deployable named.
		const unscoped = Effect.gen(function* () {
			const bound = yield* StripeSecretKey.optional
			return reveal(bound)
		})
		expect(Exit.isFailure(run(withSecretGuard(unscoped), STRIPE))).toBe(true)
	})

	it("still resolves a granted secret inside a guarded stack", () => {
		const exit = run(withSecretGuard(resolveAs("api", StripeSecretKey.required)), STRIPE)
		assert(Exit.isSuccess(exit))
		expect(reveal(exit.value)).toEqual(STRIPE)
	})

	it("leaves config that is not a secret alone, scoped or not", () => {
		const plain = Effect.gen(function* () {
			const provider = yield* Config.String("MAPLE_LLM_PROVIDER")
			return { provider }
		})
		const exit = run(withSecretGuard(plain), { MAPLE_LLM_PROVIDER: "openrouter" })
		assert(Exit.isSuccess(exit))
		expect(exit.value).toEqual({ provider: "openrouter" })
	})
})

describe("a per-consumer secret", () => {
	class RollableToken extends Secret<RollableToken>()("ROLLABLE_TOKEN", {
		issuer: "maple",
		consumers: ["api", "chat-bot"],
		perConsumer: true,
	}) {}

	// No catalog secret is per-consumer yet, so the guard is built over this one.
	const provider = guardWith([RollableToken])(
		ConfigProvider.fromUnknown({
			ROLLABLE_TOKEN: "shared",
			API_ROLLABLE_TOKEN: "api-only",
			CHAT_BOT_ROLLABLE_TOKEN: "chat-bot-only",
		}),
	)
	const readAs = (consumer: SecretConsumer) =>
		Effect.runSync(
			Effect.exit(
				RollableToken.required
					.parse(provider)
					.pipe(Effect.provideService(CurrentSecretConsumer, Option.some(consumer))),
			),
		)

	it("reads each consumer's own value and binds it under the unprefixed name", () => {
		const api = readAs("api")
		const chatBot = readAs("chat-bot")
		assert(Exit.isSuccess(api) && Exit.isSuccess(chatBot))
		expect(reveal(api.value)).toEqual({ ROLLABLE_TOKEN: "api-only" })
		expect(reveal(chatBot.value)).toEqual({ ROLLABLE_TOKEN: "chat-bot-only" })
	})

	it("refuses a consumer it is not granted to, rather than falling back to the shared value", () => {
		expect(Exit.isFailure(readAs("ai"))).toBe(true)
	})
})

describe("a Worker's resolved env", () => {
	it("refuses a secret built by hand that no registry declares", () => {
		const handMade = Config.String("SOME_VENDOR_TOKEN").pipe(
			Config.map((value) => ({ SOME_VENDOR_TOKEN: Redacted.make(value) })),
		)
		const env = { SOME_VENDOR_TOKEN: "x" }
		expect(Exit.isFailure(run(resolveWorkerEnv("api", handMade), env))).toBe(true)
		expect(Exit.isSuccess(run(resolveWorkerEnv("api", handMade, ["SOME_VENDOR_TOKEN"]), env))).toBe(true)
	})

	it("refuses a catalog secret that would be bound as a plain-text var", () => {
		const env = { OPENROUTER_API_KEY: "sk-or-1" }
		const asPlainText = Config.String("OPENROUTER_API_KEY").pipe(
			Config.map((value) => ({ OPENROUTER_API_KEY: value })),
		)
		expect(Exit.isFailure(run(resolveWorkerEnv("ai", asPlainText), env))).toBe(true)
		expect(Exit.isSuccess(run(resolveWorkerEnv("ai", OpenRouterApiKey.required), env))).toBe(true)
	})
})

describe("the secrets a config reads", () => {
	const both = Config.all([StripeSecretKey.optional, Config.option(Config.String("MAPLE_LLM_PROVIDER"))])

	it("are listed whether or not the environment sets them", () => {
		expect(Effect.runSync(secretsReadBy("api", both))).toEqual(["STRIPE_SECRET_KEY"])
	})

	it("cannot be listed for a deployable the catalog denies one of them", () => {
		expect(Exit.isFailure(Effect.runSync(Effect.exit(secretsReadBy("landing", both))))).toBe(true)
	})
})

describe("a secret at runtime", () => {
	const read = (env: Env) =>
		Effect.runSync(
			StripeSecretKey.useSync((bound) => bound).pipe(
				Effect.provide(
					StripeSecretKey.layer.pipe(
						Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
					),
				),
			),
		)

	it("is the bound value, and absent when the Worker was not given one", () => {
		expect(Option.map(read(STRIPE), Redacted.value)).toEqual(Option.some("sk_test_1"))
		expect(read({})).toEqual(Option.none())
	})

	it("carries its name, so a log line says which secret it was", () => {
		expect(Option.getOrThrow(read(STRIPE)).label).toBe("STRIPE_SECRET_KEY")
	})
})
