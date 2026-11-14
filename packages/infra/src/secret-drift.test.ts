import { Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import type { SecretEnvironment } from "./secret.ts"
import { type EnvironmentSnapshot, secretDrift } from "./secret-drift.ts"

const snapshot = (environment: SecretEnvironment, held: Record<string, string>): EnvironmentSnapshot => ({
	environment,
	fingerprints: new Map(Rec.toEntries(held)),
})

const nothingElseRead = () => false

describe("secret drift", () => {
	it("is empty when each environment holds its own values where the catalog allows them", () => {
		const drift = secretDrift(
			[
				snapshot("dev", { LINEAR_OAUTH_CLIENT_SECRET: "a", PREVIEW_SIGNIN_KEY: "p" }),
				snapshot("preview", { LINEAR_OAUTH_CLIENT_SECRET: "b", PREVIEW_SIGNIN_KEY: "p" }),
				snapshot("prod", { LINEAR_OAUTH_CLIENT_SECRET: "c" }),
				snapshot("prod-eu", { LINEAR_OAUTH_CLIENT_SECRET: "d" }),
			],
			nothingElseRead,
		)
		expect(drift).toEqual([])
	})

	it("flags a secret held where the catalog keeps it out", () => {
		const drift = secretDrift([snapshot("preview", { CLERK_WEBHOOK_SECRET: "w" })], nothingElseRead)
		expect(drift).toEqual([{ kind: "misplaced", key: "CLERK_WEBHOOK_SECRET", environment: "preview" }])
	})

	it("flags dev or preview holding a prd instance's own value, unless the catalog shares it", () => {
		const drift = secretDrift(
			[
				snapshot("preview", { LINEAR_OAUTH_CLIENT_SECRET: "live", MAPLE_OTEL_INGEST_KEY: "k" }),
				snapshot("prod", { LINEAR_OAUTH_CLIENT_SECRET: "live", MAPLE_OTEL_INGEST_KEY: "k" }),
				snapshot("prod-eu", { LINEAR_OAUTH_CLIENT_SECRET: "eu", MAPLE_OTEL_INGEST_KEY: "k" }),
			],
			nothingElseRead,
		)
		expect(drift).toEqual([
			{
				kind: "shared",
				key: "LINEAR_OAUTH_CLIENT_SECRET",
				environment: "preview",
				prdEnvironments: ["prod"],
			},
		])
	})

	it("lets only the environments the catalog names share a prd value", () => {
		const drift = secretDrift(
			[
				snapshot("dev", { TINYBIRD_TOKEN: "admin" }),
				snapshot("preview", { TINYBIRD_TOKEN: "admin" }),
				snapshot("prod", { TINYBIRD_TOKEN: "admin" }),
				snapshot("prod-eu", { TINYBIRD_TOKEN: "eu" }),
			],
			nothingElseRead,
		)
		expect(drift).toEqual([
			{ kind: "shared", key: "TINYBIRD_TOKEN", environment: "preview", prdEnvironments: ["prod"] },
		])
	})

	it("flags a secret only one prd instance holds, unless the catalog limits it to that one", () => {
		const drift = secretDrift(
			[snapshot("prod", { OPENROUTER_API_KEY: "o" }), snapshot("prod-eu", {})],
			nothingElseRead,
		)
		expect(drift).toEqual([{ kind: "uneven", key: "OPENROUTER_API_KEY", heldBy: "prod" }])
	})

	it("flags a name neither catalogued nor read, and leaves one the repo reads", () => {
		const drift = secretDrift(
			[snapshot("dev", { OLD_TOKEN: "x", TINYBIRD_HOST: "h" }), snapshot("prod", { OLD_TOKEN: "y" })],
			(key) => key === "TINYBIRD_HOST",
		)
		expect(drift).toEqual([{ kind: "unread", key: "OLD_TOKEN", environments: ["dev", "prod"] }])
	})
})
