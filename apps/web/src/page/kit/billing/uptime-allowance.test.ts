import { BillingBalance, BillingCustomer } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { monitorAllowanceOf } from "./uptime-allowance"

const customerWith = (balance: BillingBalance | undefined) =>
	balance === undefined
		? new BillingCustomer({ id: "org_acme", subscriptions: [] })
		: new BillingCustomer({ id: "org_acme", subscriptions: [], balances: { uptime_monitors: balance } })

describe("monitorAllowanceOf", () => {
	it("reads a paid plan's balance as billed past its grant", () => {
		expect(
			monitorAllowanceOf(
				customerWith(new BillingBalance({ granted: 10, usage: 14, overageAllowed: true })),
			),
		).toEqual({ included: 10, used: 14, isBilledPastIncluded: true })
	})

	it("reads a trial's balance as a hard cap", () => {
		expect(monitorAllowanceOf(customerWith(new BillingBalance({ granted: 10, usage: 4 })))).toEqual({
			included: 10,
			used: 4,
			isBilledPastIncluded: false,
		})
	})

	it("has nothing to say for an unlimited plan or one without the meter", () => {
		expect(monitorAllowanceOf(customerWith(new BillingBalance({ unlimited: true })))).toBeNull()
		expect(monitorAllowanceOf(customerWith(undefined))).toBeNull()
	})
})
