import { assert, describe, it } from "@effect/vitest"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { BillingCustomer, OrgId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { orgAuditBudget, planMonthlyInvocations, SecurityAuditPlanBudget } from "./SecurityAuditPlanBudget"
import { MAX_LIMIT } from "./limits"

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

describe("planMonthlyInvocations", () => {
	it("is the invocations the plan grants", () => {
		const granted = customer({ security_audit_invocations: { granted: 600, usage: 20, remaining: 580 } })
		assert.strictEqual(planMonthlyInvocations(granted, 20_000), 600)
	})

	it("is none for a plan without the feature", () => {
		assert.deepStrictEqual(
			[
				planMonthlyInvocations(withoutBalances, 20_000),
				planMonthlyInvocations(customer({ ai_credits: { granted: 10 } }), 20_000),
			],
			[0, 0],
		)
	})

	it("caps an unlimited balance at the unmetered allowance", () => {
		const unlimited = customer({ security_audit_invocations: { unlimited: true, granted: null } })
		assert.strictEqual(planMonthlyInvocations(unlimited, 5_000), 5_000)
	})
})

describe("orgAuditBudget", () => {
	const NOW = Date.UTC(2026, 9, 24, 12)
	const START = Date.UTC(2026, 9, 7, 9)
	const END = Date.UTC(2026, 10, 7, 9)
	const billed = (subscription: Record<string, unknown>) =>
		Schema.decodeUnknownSync(BillingCustomer)({
			id: "org_a",
			subscriptions: [subscription],
			balances: { security_audit_invocations: { granted: 600, usage: 590, remaining: 10 } },
		})

	it("keys the budget on the subscription's own cycle and caps it at Autumn's remaining", () => {
		const customer = billed({
			planId: "startup",
			status: "active",
			currentPeriodStart: START,
			currentPeriodEnd: END,
		})
		assert.deepStrictEqual(orgAuditBudget(customer, 20_000, NOW), {
			limit: 600,
			period: "cycle:2026-10-07T09:00:00.000Z",
			resetsAt: END,
			autumnRemaining: 10,
		})
	})

	it("keeps the cycle's key and reset when the subscription goes past_due mid-cycle", () => {
		const active = billed({
			planId: "startup",
			status: "active",
			currentPeriodStart: START,
			currentPeriodEnd: END,
		})
		const pastDue = billed({
			planId: "startup",
			status: "past_due",
			currentPeriodStart: START,
			currentPeriodEnd: END,
		})
		const keyOf = (budget: ReturnType<typeof orgAuditBudget>) => [budget.period, budget.resetsAt]
		assert.deepStrictEqual(
			keyOf(orgAuditBudget(pastDue, 20_000, NOW)),
			keyOf(orgAuditBudget(active, 20_000, NOW)),
		)
	})

	it("falls back to the UTC month without a current billing period, and for an unmetered org", () => {
		const withoutPeriod = billed({ planId: "startup", status: "active" })
		const addOnOnly = billed({
			planId: "byok",
			status: "active",
			addOn: true,
			currentPeriodStart: START,
			currentPeriodEnd: END,
		})
		const month = { period: "2026-10", resetsAt: Date.UTC(2026, 10, 1) }
		assert.deepStrictEqual(
			[
				orgAuditBudget(withoutPeriod, 20_000, NOW),
				orgAuditBudget(addOnOnly, 20_000, NOW).period,
				orgAuditBudget(null, 20_000, NOW),
			],
			[
				{ limit: 600, ...month, autumnRemaining: 10 },
				"2026-10",
				{ limit: 20_000, ...month, autumnRemaining: null },
			],
		)
	})
})

describe("SecurityAuditPlanBudget", () => {
	const NOW = Date.UTC(2026, 9, 24, 12)
	const CUSTOMER_ORG = Schema.decodeUnknownSync(OrgId)("org_customer")
	const MAPLE_ORG = Schema.decodeUnknownSync(OrgId)("default")

	/** The service over a stubbed Autumn that answers every call with `status`. */
	const budgetFor = (orgId: OrgId, config: Record<string, unknown>, status: number) =>
		Effect.gen(function* () {
			const service = yield* SecurityAuditPlanBudget
			return yield* service.budget(orgId, NOW)
		}).pipe(
			Effect.provide(
				Layer.effect(SecurityAuditPlanBudget, SecurityAuditPlanBudget.make).pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.effect(AutumnClient, AutumnClient.make).pipe(
								Layer.provide(FetchHttpClient.layer),
								Layer.provide(
									Layer.succeed(FetchHttpClient.Fetch, () =>
										Promise.resolve(new Response('{"code":"unauthorized"}', { status })),
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

	it.effect("refuses, not unmeters, when billing rejects a configured key", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				budgetFor(CUSTOMER_ORG, { AUTUMN_SECRET_KEY: "am_sk_test" }, 401),
			)
			assert.strictEqual(error._tag, "@maple/backend/security-audit/PlanUnavailable")
		}),
	)

	it.effect("unmeters every org on a deployment without billing", () =>
		Effect.gen(function* () {
			const budget = yield* budgetFor(CUSTOMER_ORG, {}, 401)
			assert.deepStrictEqual([budget.limit, budget.autumnRemaining], [20_000, null])
		}),
	)

	it.effect("unmeters Maple's own org even with billing configured", () =>
		Effect.gen(function* () {
			const budget = yield* budgetFor(MAPLE_ORG, { AUTUMN_SECRET_KEY: "am_sk_test" }, 401)
			assert.deepStrictEqual([budget.limit, budget.autumnRemaining], [20_000, null])
		}),
	)

	it.effect("caps a configured unmetered allowance at what Postgres can compare", () =>
		Effect.gen(function* () {
			const budget = yield* budgetFor(
				MAPLE_ORG,
				{ SECURITY_AUDIT_UNMETERED_MONTHLY_INVOCATIONS: "99999999999" },
				401,
			)
			assert.strictEqual(budget.limit, MAX_LIMIT)
		}),
	)
})
