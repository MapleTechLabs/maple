import { assert, describe, it } from "@effect/vitest"
import { makeResolveTenant } from "@maple/auth"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { Env } from "@maple/backend/platform/Env"

// A session in org_123 that is not a member of the pinned org.
const nonMemberSession = async () => ({
	isAuthenticated: true,
	message: null,
	toAuth: () => ({
		isAuthenticated: true,
		tokenType: "session_token",
		userId: "user_123",
		orgId: "org_123",
		orgRole: "org:admin",
	}),
})

const envWith = (extra: Record<string, string>) =>
	Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: "sk_test_123",
					CLERK_JWT_KEY: "jwt_test_123",
					MAPLE_ORG_ID_OVERRIDE: "org_pinned",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					...extra,
				}),
			),
		),
	)

const resolvePinned = Effect.gen(function* () {
	const env = yield* Env
	return yield* makeResolveTenant(
		env,
		nonMemberSession,
	)({ authorization: "Bearer test-token" }).pipe(Effect.exit)
})

describe("MAPLE_ORG_ID_OVERRIDE with the deployment's Env", () => {
	it.effect("refuses a non-member when MAPLE_ENVIRONMENT is unset", () =>
		Effect.gen(function* () {
			const exit = yield* resolvePinned
			assert.isTrue(Exit.isFailure(exit))
		}).pipe(Effect.provide(envWith({}))),
	)

	it.effect("admits a non-member only with the explicit development opt-in", () =>
		Effect.gen(function* () {
			const exit = yield* resolvePinned
			assert.isTrue(Exit.isSuccess(exit))
		}).pipe(Effect.provide(envWith({ MAPLE_ORG_ID_OVERRIDE_ADMITS_NONMEMBERS: "true" }))),
	)
})
