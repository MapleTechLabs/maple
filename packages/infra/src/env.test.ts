import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import {
	apnsEnv,
	appUrlsEnv,
	authEnv,
	cloudflareOAuthEnv,
	derived,
	ingestKeyCryptoEnv,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	plainWithDefault,
	PRD_LOCKSTEP_REVISION_SERVICES,
	requiredPlain,
	selfObservabilityEnv,
	tinybirdEnv,
	type WorkerEnv,
} from "./env.ts"
import { stageDeploysElectric, stageDeploysIngest } from "./aws/stage.ts"

/**
 * These groups replaced per-worker copies of the same expressions. The parity
 * blocks below reconstruct the OLD expressions verbatim (from the pre-refactor
 * `apps/api` and `apps/alerting` stack files, with the `process.env` lookup
 * swapped for an explicit record) and assert the group produces an identical
 * result — that equivalence, not the group's internals, is what keeps a
 * deploy's Worker bindings unchanged.
 *
 * Everything runs against an explicit `ConfigProvider` rather than by mutating
 * `process.env`, which is also the point of the refactor: alchemy resolves
 * config through a provider layered over `.env` / `--env-file`, so that is the
 * path worth testing.
 */

type Env = Record<string, string>

const run = <A>(config: Config.Config<A>, env: Env): A =>
	Effect.runSync(config.parse(ConfigProvider.fromUnknown(env)))

const runExit = <A>(config: Config.Config<A>, env: Env) =>
	Effect.runSync(Effect.exit(config.parse(ConfigProvider.fromUnknown(env))))

/** Compare records where secret values are `Redacted` (not deep-equal friendly). */
const unwrap = (env: WorkerEnv): Env =>
	Object.fromEntries(
		Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : `redacted:${Redacted.value(v)}`]),
	)

describe("primitives", () => {
	it("resolves a value present only in the provider, not in process.env", () => {
		// The regression this refactor exists to prevent: alchemy layers
		// `fromDotEnv(.env / --env-file)` over `fromEnv()` and never copies those
		// values into process.env, so a process.env read would miss this entirely.
		expect("MAPLE_ENDPOINT" in process.env).toBe(false)
		expect(run(optionalPlain("MAPLE_ENDPOINT"), { MAPLE_ENDPOINT: "https://from-dotenv" })).toEqual({
			MAPLE_ENDPOINT: "https://from-dotenv",
		})
	})

	it("requiredPlain fails on absent, empty and whitespace-only values", () => {
		expect(runExit(requiredPlain("TINYBIRD_HOST"), {})._tag).toBe("Failure")
		expect(runExit(requiredPlain("TINYBIRD_HOST"), { TINYBIRD_HOST: "" })._tag).toBe("Failure")
		expect(runExit(requiredPlain("TINYBIRD_HOST"), { TINYBIRD_HOST: "   " })._tag).toBe("Failure")
	})

	it("requiredPlain trims", () => {
		expect(run(requiredPlain("TINYBIRD_HOST"), { TINYBIRD_HOST: "  https://api.tinybird.co  " })).toBe(
			"https://api.tinybird.co",
		)
	})

	it("omits an unset optional key entirely rather than binding an empty string", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT"), {})).toEqual({})
		expect(run(optionalSecret("CLERK_JWT_KEY"), {})).toEqual({})
		expect("MAPLE_ENDPOINT" in run(optionalPlain("MAPLE_ENDPOINT"), {})).toBe(false)
	})

	it("treats a whitespace-only optional value as absent", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT"), { MAPLE_ENDPOINT: "   " })).toEqual({})
		expect(run(optionalSecret("CLERK_JWT_KEY"), { CLERK_JWT_KEY: "  " })).toEqual({})
	})

	it("trims optional values", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT"), { MAPLE_ENDPOINT: " https://x " })).toEqual({
			MAPLE_ENDPOINT: "https://x",
		})
	})

	it("redacts optional secrets", () => {
		const record = run(optionalSecret("CLERK_JWT_KEY"), { CLERK_JWT_KEY: "jwt-secret" })
		expect(String(record.CLERK_JWT_KEY)).not.toContain("jwt-secret")
		expect(Redacted.value(record.CLERK_JWT_KEY!)).toBe("jwt-secret")
	})

	it("applies an optionalPlain fallback only when the key is absent", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT", "https://fallback"), {})).toEqual({
			MAPLE_ENDPOINT: "https://fallback",
		})
		expect(
			run(optionalPlain("MAPLE_ENDPOINT", "https://fallback"), { MAPLE_ENDPOINT: "https://env" }),
		).toEqual({ MAPLE_ENDPOINT: "https://env" })
	})

	it("plainWithDefault also falls back for a blank value, unlike Config.withDefault", () => {
		expect(run(plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"), {})).toEqual({
			MAPLE_AUTH_MODE: "self_hosted",
		})
		expect(run(plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"), { MAPLE_AUTH_MODE: "  " })).toEqual({
			MAPLE_AUTH_MODE: "self_hosted",
		})
		expect(run(plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"), { MAPLE_AUTH_MODE: "clerk" })).toEqual(
			{ MAPLE_AUTH_MODE: "clerk" },
		)
	})

	it("derived ignores the provider — that is the whole point of it", () => {
		expect(run(derived("MAPLE_ENVIRONMENT", "pr-42"), { MAPLE_ENVIRONMENT: "production" })).toEqual({
			MAPLE_ENVIRONMENT: "pr-42",
		})
	})
})

describe("appUrlsEnv", () => {
	it("defaults the public URLs to the deploy's own hostnames, so the EU instance links to itself", () => {
		const eu = run(appUrlsEnv({ web: "app.eu.maple.dev", ingest: "ingest.eu.maple.dev" }), {})
		expect(eu.MAPLE_APP_BASE_URL).toBe("https://app.eu.maple.dev")
		expect(eu.MAPLE_INGEST_PUBLIC_URL).toBe("https://ingest.eu.maple.dev")
		// A dev stage has no hostnames and falls back to production's.
		expect(run(appUrlsEnv({}), {}).MAPLE_APP_BASE_URL).toBe("https://app.maple.dev")
	})

	it("still lets the environment override a default", () => {
		const env = { MAPLE_APP_BASE_URL: "https://app.example.test" }
		expect(run(appUrlsEnv({ web: "app.eu.maple.dev" }), env).MAPLE_APP_BASE_URL).toBe(
			"https://app.example.test",
		)
	})
})

describe("selfObservabilityEnv", () => {
	const base = { MAPLE_OTEL_INGEST_KEY: "maple_ak_test" }

	it("derives MAPLE_REGION from the deploy and refuses a provider override", () => {
		const env = { ...base, MAPLE_REGION: "eu" }
		expect(run(selfObservabilityEnv({ kind: "prd" }), env).MAPLE_REGION).toBe("us")
		expect(run(selfObservabilityEnv({ kind: "prd" }, "eu"), env).MAPLE_REGION).toBe("eu")
	})

	it("stamps the region on the Workers' telemetry resource, whatever the provider says", () => {
		const env = { ...base, OTEL_RESOURCE_ATTRIBUTES: "maple.region=mars" }
		expect(run(selfObservabilityEnv({ kind: "prd" }), env).OTEL_RESOURCE_ATTRIBUTES).toBe(
			"maple.region=us",
		)
		expect(run(selfObservabilityEnv({ kind: "prd" }, "eu"), env).OTEL_RESOURCE_ATTRIBUTES).toBe(
			"maple.region=eu",
		)
	})

	it("derives MAPLE_ENVIRONMENT from the stage and refuses a provider override", () => {
		const env = { ...base, MAPLE_ENVIRONMENT: "production" }
		expect(run(selfObservabilityEnv({ kind: "pr", prNumber: 42 }), env).MAPLE_ENVIRONMENT).toBe("pr-42")
		expect(run(selfObservabilityEnv({ kind: "prd" }), env).MAPLE_ENVIRONMENT).toBe("production")
		expect(run(selfObservabilityEnv({ kind: "dev", name: "x" }), env).MAPLE_ENVIRONMENT).toBe(
			"development",
		)
	})

	it("falls back to GITHUB_SHA when COMMIT_SHA is unset", () => {
		expect(run(selfObservabilityEnv({ kind: "prd" }), { ...base, GITHUB_SHA: "abc123" }).COMMIT_SHA).toBe(
			"abc123",
		)
	})

	it("prefers COMMIT_SHA over GITHUB_SHA", () => {
		const env = { ...base, GITHUB_SHA: "abc123", COMMIT_SHA: "def456" }
		expect(run(selfObservabilityEnv({ kind: "prd" }), env).COMMIT_SHA).toBe("def456")
	})

	it("omits COMMIT_SHA when neither is set", () => {
		expect("COMMIT_SHA" in run(selfObservabilityEnv({ kind: "prd" }), base)).toBe(false)
	})

	it("binds the ingest key redacted, under the MAPLE_INGEST_KEY name", () => {
		const env = run(selfObservabilityEnv({ kind: "prd" }), base)
		expect(Redacted.value(env.MAPLE_INGEST_KEY as Redacted.Redacted<string>)).toBe("maple_ak_test")
		expect("MAPLE_OTEL_INGEST_KEY" in env).toBe(false)
	})

	it("fails when the ingest key is missing", () => {
		expect(runExit(selfObservabilityEnv({ kind: "prd" }), {})._tag).toBe("Failure")
		expect(runExit(selfObservabilityEnv({ kind: "pr", prNumber: 7 }), {})._tag).toBe("Failure")
	})

	it("omits the ingest key on a dev stage rather than failing", () => {
		// `alchemy dev` resolves this contract on the developer's machine, where
		// there is no ingest key — a required one refuses to start the stack.
		const env = run(selfObservabilityEnv({ kind: "dev", name: "x" }), {})
		expect("MAPLE_INGEST_KEY" in env).toBe(false)
		expect(env.MAPLE_ENVIRONMENT).toBe("development")
	})

	it("still binds the ingest key on a dev stage when one is set", () => {
		const env = run(selfObservabilityEnv({ kind: "dev", name: "x" }), base)
		expect(Redacted.value(env.MAPLE_INGEST_KEY as Redacted.Redacted<string>)).toBe("maple_ak_test")
		expect("MAPLE_OTEL_INGEST_KEY" in env).toBe(false)
	})
})

/**
 * The alert rule this pins lives in the Maple database, not in this repo, so
 * these assertions are the only thing standing between a stack change and a
 * rule that silently stops matching production.
 */
describe("the prd revision lockstep the skew alert depends on", () => {
	it("covers exactly the services that deploy together and stamp a revision", () => {
		// If this fails you changed which services ship in one `alchemy deploy
		// --stage prd`. Edit the SQL of the "Prod revision skew — a Worker missed
		// the deploy" rule (2a6e9529-5f73-4478-9fa0-432904ff15c8) to match, THEN
		// update this list. Out of sync, the rule either pages forever on a
		// service that no longer ships with the rest, or stops covering one
		// that does.
		expect([...PRD_LOCKSTEP_REVISION_SERVICES]).toStrictEqual([
			"alerting",
			"maple-ai",
			"electric-sync",
			"ingest",
			"maple-api",
			"maple-web",
		])
	})

	it("only claims lockstep for the stage-gated services prd actually deploys", () => {
		// `ingest` and `electric-sync` are the two members behind a stage
		// predicate. Flip either away from prd and it stops tracking the other
		// three, so it has to leave the list — and the rule's SQL — in the same
		// change.
		const prd = { kind: "prd" } as const
		expect(PRD_LOCKSTEP_REVISION_SERVICES.includes("ingest")).toBe(stageDeploysIngest(prd))
		expect(PRD_LOCKSTEP_REVISION_SERVICES.includes("electric-sync")).toBe(stageDeploysElectric(prd))
	})
})
