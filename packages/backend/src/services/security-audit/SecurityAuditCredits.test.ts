import { assert, describe, it } from "@effect/vitest"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { BillingCustomer, OrgId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { missingCredits, SecurityAuditCredits } from "./SecurityAuditCredits"

const customer = (balances: Record<string, unknown>) =>
	Schema.decodeUnknownSync(BillingCustomer)({
		id: "org_a",
		subscriptions: [{ planId: "startup", status: "active" }],
		balances,
	})

const withoutBalances = Schema.decodeUnknownSync(BillingCustomer)({
	id: "org_a",
	subscriptions: [{ planId: "startup", status: "active" }],
})

describe("missingCredits", () => {
	it("lets an org with AI credits left start", () => {
		assert.isTrue(Option.isNone(missingCredits(customer({ ai_credits: { granted: 10, remaining: 4 } }))))
	})

	it("lets an org that has spent its credits start while its plan bills overage", () => {
		const overage = customer({ ai_credits: { granted: 10, remaining: -3, overageAllowed: true } })
		assert.isTrue(Option.isNone(missingCredits(overage)))
	})

	it("refuses a plan without AI credits, and one whose credits are spent with no overage", () => {
		const refusals = [
			withoutBalances,
			customer({ logs: { granted: 100 } }),
			customer({ ai_credits: { granted: 10, remaining: 0, overageAllowed: false } }),
		].map((c) => Option.isSome(missingCredits(c)))
		assert.deepStrictEqual(refusals, [true, true, true])
	})
})

describe("SecurityAuditCredits", () => {
	const CUSTOMER_ORG = Schema.decodeUnknownSync(OrgId)("org_customer")
	const MAPLE_ORG = Schema.decodeUnknownSync(OrgId)("default")

	/** The service over a stubbed Autumn that answers every call with `status` and `body`. */
	const ensureFor = (orgId: OrgId, config: Record<string, unknown>, status: number, body: string) =>
		Effect.gen(function* () {
			const service = yield* SecurityAuditCredits
			return yield* service.ensure(orgId)
		}).pipe(
			Effect.provide(
				Layer.effect(SecurityAuditCredits, SecurityAuditCredits.make).pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.effect(AutumnClient, AutumnClient.make).pipe(
								Layer.provide(FetchHttpClient.layer),
								Layer.provide(
									Layer.succeed(FetchHttpClient.Fetch, () =>
										Promise.resolve(new Response(body, { status })),
									),
								),
							),
							EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
						),
					),
					Layer.provideMerge(Env.layer),
					Layer.provideMerge(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({
								PORT: "3472",
								TINYBIRD_HOST: "https://api.tinybird.co",
								TINYBIRD_TOKEN: "test-token",
								MAPLE_AUTH_MODE: "self_hosted",
								MAPLE_ROOT_PASSWORD: "test-root-password",
								MAPLE_DEFAULT_ORG_ID: "default",
								MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
								MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
								...config,
							}),
						),
					),
				),
			),
		)

	const BILLED = { AUTUMN_SECRET_KEY: "am_sk_test" }
	const UNAUTHORIZED = '{"code":"unauthorized"}'

	it.effect("refuses, not unmeters, when billing rejects a configured key", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(ensureFor(CUSTOMER_ORG, BILLED, 401, UNAUTHORIZED))
			assert.strictEqual(error._tag, "@maple/backend/security-audit/CreditsUnavailable")
		}),
	)

	it.effect("refuses an org whose plan has no AI credits", () =>
		Effect.gen(function* () {
			const body = JSON.stringify({ id: "org_customer", subscriptions: [], balances: {} })
			const error = yield* Effect.flip(ensureFor(CUSTOMER_ORG, BILLED, 200, body))
			assert.strictEqual(error._tag, "@maple/backend/security-audit/NoCredits")
		}),
	)

	it.effect("lets every org start on a deployment without billing, and Maple's own org always", () =>
		Effect.gen(function* () {
			yield* ensureFor(CUSTOMER_ORG, {}, 401, UNAUTHORIZED)
			yield* ensureFor(MAPLE_ORG, BILLED, 401, UNAUTHORIZED)
		}),
	)
})
