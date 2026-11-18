import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { Env } from "./Env"

const buildEnv = (overrides: Record<string, string>) =>
	Layer.build(
		Env.layer.pipe(
			Layer.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						TINYBIRD_HOST: "https://api.tinybird.co",
						TINYBIRD_TOKEN: "test-token",
						MAPLE_DEFAULT_ORG_ID: "default",
						MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
						MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
						...overrides,
					}),
				),
			),
		),
	).pipe(Effect.scoped)

describe("Env root password policy", () => {
	it.effect("refuses to start self-hosted with a placeholder or short root password", () =>
		Effect.gen(function* () {
			const placeholder = yield* Effect.flip(
				buildEnv({ MAPLE_AUTH_MODE: "self_hosted", MAPLE_ROOT_PASSWORD: "change-me" }),
			)
			expect(placeholder.message).toContain("placeholder")

			const short = yield* Effect.flip(
				buildEnv({ MAPLE_AUTH_MODE: "self_hosted", MAPLE_ROOT_PASSWORD: "fifteen-chars!!" }),
			)
			expect(short.message).toContain("at least 16 characters")
		}),
	)

	it.effect("starts self-hosted with a generated root password", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				buildEnv({
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "q3V9n0bS1xYp4LmK8rT2wZcA",
				}),
			)
			expect(Exit.isSuccess(exit)).toBe(true)
		}),
	)
})
