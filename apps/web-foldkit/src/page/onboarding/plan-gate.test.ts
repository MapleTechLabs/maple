import { OrgId } from "@maple/domain"
import { BillingCustomer, BillingSubscription } from "@maple/domain/http"
import { Option } from "effect"
import { describe, expect, test } from "vitest"
import type { ClerkOrganization } from "../../platform/clerk"
import { AppRoute, hrefOf } from "../../route"
import { CustomerData, type CustomerSlot, isRouteHeld, planGate } from "./plan-gate"

const organization: ClerkOrganization = {
	id: OrgId.make("org_1"),
	name: "Acme",
	imageUrl: "",
	homeRegion: "us",
	isServedHere: true,
	isRegionOpen: false,
	flags: { aiAutoTriage: false, releases: false },
}

const customerWith = (status: string | null): CustomerSlot => ({
	orgId: "org_1",
	data: CustomerData.Success({
		data: new BillingCustomer({
			id: "org_1",
			subscriptions: status === null ? [] : [new BillingSubscription({ planId: "startup", status })],
		}),
	}),
})

const loading: CustomerSlot = { orgId: "org_1", data: CustomerData.Loading() }
const home = AppRoute.Home({ search: {} })

const gate = (route: AppRoute, customer: CustomerSlot, isKnownToRenderApp = false) =>
	planGate({ route, organization: Option.some(organization), customer, isKnownToRenderApp })

describe("plan gate", () => {
	test("while the plan loads, the app waits on the splash unless this browser knows the org", () => {
		expect(gate(home, loading)).toEqual({ redirect: Option.none(), isSplash: true })
		expect(gate(home, loading, true).isSplash).toBe(false)
		expect(gate(AppRoute.QuickStart({ search: {} }), loading).isSplash).toBe(false)
	})

	test("an org that never held a plan is sent to onboarding with its destination", () => {
		expect(gate(home, customerWith(null)).redirect).toEqual(
			Option.some({ url: hrefOf(AppRoute.QuickStart({ search: { redirect_url: "/" } })), isReplace: true }),
		)
	})

	test("a subscriber leaves the onboarding wizard and the plan picker", () => {
		expect(gate(AppRoute.QuickStart({ search: {} }), customerWith("active")).redirect).toEqual(
			Option.some({ url: "/", isReplace: true }),
		)
		expect(gate(AppRoute.SelectPlan({ search: { redirect_url: "/traces" } }), customerWith("active")).redirect).toEqual(
			Option.some({ url: "/traces", isReplace: true }),
		)
	})

	test("a failed customer read fails open", () => {
		expect(gate(home, { orgId: "org_1", data: CustomerData.Failure({ error: "Failed" }) })).toEqual({
			redirect: Option.none(),
			isSplash: false,
		})
	})

	test("the route mounts (its page is built) only once the gate lets the app render", () => {
		expect(isRouteHeld(gate(home, loading))).toBe(true)
		expect(isRouteHeld(gate(home, customerWith(null)))).toBe(true)
		expect(isRouteHeld(gate(home, loading, true))).toBe(false)
	})

	test("the unsubscribe page never reads the plan", () => {
		expect(gate(AppRoute.Unsubscribe({ search: {} }), customerWith(null)).redirect).toEqual(Option.none())
	})
})
