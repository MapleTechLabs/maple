import { assert, describe, it } from "@effect/vitest"
import { BillingCustomer } from "@maple/domain/http"
import { Schema } from "effect"
import { orgAuditBudget, planMonthlyInvocations } from "./SecurityAuditPlanBudget"

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
