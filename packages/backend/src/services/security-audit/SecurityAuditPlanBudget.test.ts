import { assert, describe, it } from "@effect/vitest"
import { BillingCustomer } from "@maple/domain/http"
import { Schema } from "effect"
import { planMonthlyInvocations } from "./SecurityAuditPlanBudget"

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
