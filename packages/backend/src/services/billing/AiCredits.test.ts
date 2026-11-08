import { assert, describe, it } from "@effect/vitest"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { BillingCustomer, OrgId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { OrgOpenRouterKeyService } from "@maple/backend/services/org/OrgOpenRouterKeyService"
import { AiCredits, missingAiCredits } from "./AiCredits"

const customer = (balances: Record<string, unknown>, spendLimits?: ReadonlyArray<unknown>) =>
	Schema.decodeUnknownSync(BillingCustomer)({
		id: "org_a",
		subscriptions: [{ planId: "startup", status: "active" }],
		balances,
		...(spendLimits === undefined ? undefined : { billingControls: { spendLimits } }),
	})

const withoutBalances = Schema.decodeSync(BillingCustomer)({
	id: "org_a",
	subscriptions: [{ planId: "startup", status: "active" }],
})

describe("missingAiCredits", () => {
	const NOW = Date.UTC(2026, 9, 24, 12)
	const reasonOf = (c: BillingCustomer) => Option.map(missingAiCredits(c, NOW), (refusal) => refusal.reason)
	const resetOf = (c: BillingCustomer) =>
		Option.map(missingAiCredits(c, NOW), (refusal) => refusal.resetsAt)

	it("lets an org with AI credits left spend, or one whose plan bills overage without a cap", () => {
		const allowed = Arr.map(
			[
				customer({
					ai_credits: { granted: 10, usage: 0.249, remaining: 9.75, overageAllowed: true },
				}),
				customer({ ai_credits: { granted: 10, remaining: 4 } }),
				customer({ ai_credits: { granted: 10, usage: 13, remaining: -3, overageAllowed: true } }),
				customer({ ai_credits: { unlimited: true, remaining: 0 } }),
			],
			(c) => Option.isNone(missingAiCredits(c, NOW)),
		)
		assert.deepStrictEqual(allowed, [true, true, true, true])
	})

	it("refuses a plan without AI credits for good", () => {
		assert.deepStrictEqual(
			[resetOf(withoutBalances), resetOf(customer({ logs: { granted: 100 } }))],
			[Option.some(null), Option.some(null)],
		)
		assert.deepStrictEqual(reasonOf(withoutBalances), Option.some("no_credits"))
	})

	it("refuses spent credits until their own reset, else the end of the UTC month", () => {
		const reset = Date.UTC(2026, 10, 7, 9)
		const spent = (nextResetAt: number | null) =>
			customer({ ai_credits: { granted: 10, remaining: 0, overageAllowed: false, nextResetAt } })
		assert.deepStrictEqual(
			[resetOf(spent(reset)), resetOf(spent(null))],
			[Option.some(reset), Option.some(Date.UTC(2026, 10, 1))],
		)
		assert.deepStrictEqual(reasonOf(spent(reset)), Option.some("used_up"))
	})

	describe("with a spend limit on overage", () => {
		const reset = Date.UTC(2026, 10, 7, 9)
		const overBy = (overage: number, spendLimits: ReadonlyArray<unknown>) =>
			customer(
				{
					ai_credits: {
						granted: 10,
						usage: 10 + overage,
						remaining: -overage,
						overageAllowed: true,
						nextResetAt: reset,
					},
				},
				spendLimits,
			)
		const cap = (overageLimit: number, extra: Record<string, unknown> = {}) => ({
			featureId: "ai_credits",
			enabled: true,
			overageLimit,
			...extra,
		})

		it("lets the org spend while its overage is under the cap", () => {
			assert.isTrue(Option.isNone(missingAiCredits(overBy(4.99, [cap(5)]), NOW)))
			assert.isTrue(Option.isNone(missingAiCredits(overBy(0, [cap(5)]), NOW)))
		})

		it("refuses once the overage reaches or passes the cap, until the balance resets", () => {
			const refusals = Arr.map([overBy(5, [cap(5)]), overBy(7.5, [cap(5)]), overBy(0, [cap(0)])], (c) =>
				Option.map(missingAiCredits(c, NOW), (r) => [r.reason, r.resetsAt] as const),
			)
			assert.deepStrictEqual(refusals, [
				Option.some(["cap_reached", reset] as const),
				Option.some(["cap_reached", reset] as const),
				Option.some(["cap_reached", reset] as const),
			])
			const message = Option.map(missingAiCredits(overBy(5, [cap(5)]), NOW), (r) => r.message)
			assert.isTrue(Option.exists(message, (text) => Str.includes("Settings > Billing")(text)))
		})

		it("ignores a disabled limit and a limit on another feature", () => {
			const ignored = Arr.map(
				[
					overBy(50, [cap(5, { enabled: false })]),
					overBy(50, [cap(5, { featureId: "logs" })]),
					overBy(50, [{ featureId: "ai_credits", enabled: true }]),
				],
				(c) => Option.isNone(missingAiCredits(c, NOW)),
			)
			assert.deepStrictEqual(ignored, [true, true, true])
		})
	})
})

describe("AiCredits", () => {
	const CUSTOMER_ORG = Schema.decodeSync(OrgId)("org_customer")
	const MAPLE_ORG = Schema.decodeSync(OrgId)("default")

	/** The service over a stubbed Autumn whose every answer comes from `respond`. */
	const servicesFor = (
		config: Record<string, unknown>,
		respond: () => Response,
		orgKey: Option.Option<string> = Option.none(),
	) =>
		Layer.effect(AiCredits, AiCredits.make).pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.effect(AutumnClient, AutumnClient.make).pipe(
						Layer.provide(FetchHttpClient.layer),
						Layer.provide(Layer.succeed(FetchHttpClient.Fetch, () => Promise.resolve(respond()))),
					),
					EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
					OrgOpenRouterKeyService.fixedRunKey(orgKey),
					BillingCustomerResolver.standalone,
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
		)

	/** One `ensure` over a stubbed Autumn that answers every call with `status` and `body`. */
	const ensureFor = (
		orgId: OrgId,
		config: Record<string, unknown>,
		status: number,
		body: string,
		orgKey: Option.Option<string> = Option.none(),
		options?: { readonly ownKey?: boolean },
	) =>
		Effect.gen(function* () {
			const service = yield* AiCredits
			return yield* service.ensure(orgId, options)
		}).pipe(Effect.provide(servicesFor(config, () => new Response(body, { status }), orgKey)))

	const BILLED = { AUTUMN_SECRET_KEY: "am_sk_test" }
	const UNAUTHORIZED = '{"code":"unauthorized"}'
	const NO_CREDITS = JSON.stringify({ id: "org_customer", subscriptions: [], balances: {} })

	it.effect("reports billing as unavailable, not unmetered, when it rejects a configured key", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(ensureFor(CUSTOMER_ORG, BILLED, 401, UNAUTHORIZED))
			assert.strictEqual(error._tag, "@maple/backend/billing/AiCreditsUnavailable")
		}),
	)

	it.effect(
		"confirms a cached refusal against billing before refusing, so a raised cap applies at once",
		() =>
			Effect.gen(function* () {
				const capped = JSON.stringify({
					id: "org_customer",
					subscriptions: [],
					balances: {
						ai_credits: { granted: 10, usage: 15, remaining: -5, overage_allowed: true },
					},
					billing_controls: {
						spend_limits: [
							{
								feature_id: "ai_credits",
								enabled: true,
								limit_type: "absolute",
								overage_limit: 5,
							},
						],
					},
				})
				const raised = Str.replace('"overage_limit":5', '"overage_limit":50')(capped)
				const answers = [capped, raised]
				let calls = 0
				const outcomes = yield* Effect.gen(function* () {
					const service = yield* AiCredits
					const first = yield* Effect.flip(service.ensure(CUSTOMER_ORG))
					yield* service.ensure(CUSTOMER_ORG)
					return first._tag
				}).pipe(
					Effect.provide(
						servicesFor(BILLED, () => {
							const body = answers[Math.min(calls, answers.length - 1)] ?? capped
							calls += 1
							return new Response(body, { status: 200 })
						}),
					),
				)
				assert.strictEqual(outcomes, "@maple/backend/billing/AiCreditsExhausted")
				// The second check hit the cached refusal, read billing again and found the raised cap.
				assert.strictEqual(calls, 2)
			}),
	)

	it.effect("refuses an org whose plan has no AI credits", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(ensureFor(CUSTOMER_ORG, BILLED, 200, NO_CREDITS))
			assert.strictEqual(error._tag, "@maple/backend/billing/AiCreditsExhausted")
		}),
	)

	it.effect("refuses an org at its AI spending cap", () =>
		Effect.gen(function* () {
			const body = JSON.stringify({
				id: "org_customer",
				subscriptions: [],
				balances: { ai_credits: { granted: 10, usage: 25, remaining: -15, overageAllowed: true } },
				billingControls: {
					spendLimits: [{ featureId: "ai_credits", enabled: true, overageLimit: 15 }],
				},
			})
			const reason = yield* ensureFor(CUSTOMER_ORG, BILLED, 200, body).pipe(
				Effect.as("allowed"),
				Effect.catchTag("@maple/backend/billing/AiCreditsExhausted", (error) =>
					Effect.succeed(error.reason),
				),
			)
			assert.strictEqual(reason, "cap_reached")
		}),
	)

	it.effect("lets an org on its own OpenRouter key spend without AI credits, resolved or stated", () =>
		Effect.gen(function* () {
			yield* ensureFor(CUSTOMER_ORG, BILLED, 200, NO_CREDITS, Option.some("sk-or-org"))
			yield* ensureFor(CUSTOMER_ORG, BILLED, 200, NO_CREDITS, Option.none(), { ownKey: true })
		}),
	)

	it.effect("lets every org spend on a deployment without billing, and Maple's own org always", () =>
		Effect.gen(function* () {
			yield* ensureFor(CUSTOMER_ORG, {}, 401, UNAUTHORIZED)
			yield* ensureFor(MAPLE_ORG, BILLED, 401, UNAUTHORIZED)
		}),
	)
})
