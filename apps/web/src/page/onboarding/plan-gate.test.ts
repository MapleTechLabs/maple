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
	flags: { aiAutoTriage: false, releases: false, securityAudit: false },
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
		expect(gate(home, loading)).toEqual({ redirect: Option.none(), isSplash: true, wrongRegion: null })
		expect(gate(home, loading, true).isSplash).toBe(false)
		expect(gate(AppRoute.QuickStart({ search: {} }), loading).isSplash).toBe(false)
	})

	test("an org that never held a plan is sent to onboarding with its destination", () => {
		expect(gate(home, customerWith(null)).redirect).toEqual(
			Option.some({
				url: hrefOf(AppRoute.QuickStart({ search: { redirect_url: "/" } })),
				isReplace: true,
			}),
		)
	})

	test("an org with no plan reaches billing settings, where it links to the org that pays", () => {
		const billing = AppRoute.Settings({ search: { tab: "billing" } })
		expect(gate(billing, customerWith(null)).redirect).toEqual(Option.none())
		expect(gate(billing, loading).isSplash).toBe(false)
		expect(
			Option.isSome(
				gate(AppRoute.Settings({ search: { tab: "members" } }), customerWith(null)).redirect,
			),
		).toBe(true)
	})

	test("a subscriber finishes the onboarding steps after the plan, and leaves the plan picker", () => {
		expect(gate(AppRoute.QuickStart({ search: {} }), customerWith("active")).redirect).toEqual(
			Option.none(),
		)
		expect(
			gate(AppRoute.SelectPlan({ search: { redirect_url: "/traces" } }), customerWith("active"))
				.redirect,
		).toEqual(Option.some({ url: "/traces", isReplace: true }))
	})

	test("a failed customer read fails open", () => {
		expect(gate(home, { orgId: "org_1", data: CustomerData.Failure({ error: "Failed" }) })).toEqual({
			redirect: Option.none(),
			isSplash: false,
			wrongRegion: null,
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

	test("an org another region serves gets the wrong-region screen once its choice is closed", () => {
		const elsewhere: ClerkOrganization = { ...organization, homeRegion: "eu", isServedHere: false }
		const at = (org: ClerkOrganization, route: AppRoute) =>
			planGate({ route, organization: Option.some(org), customer: loading, isKnownToRenderApp: true })
		expect(at(elsewhere, home)).toEqual({ redirect: Option.none(), isSplash: false, wrongRegion: "eu" })
		expect(at(elsewhere, AppRoute.CliLogin({ search: {} })).wrongRegion).toBe("eu")
		const open: ClerkOrganization = { ...elsewhere, isRegionOpen: true }
		expect(at(open, home).redirect).toEqual(
			Option.some({
				url: hrefOf(AppRoute.QuickStart({ search: { redirect_url: "/" } })),
				isReplace: true,
			}),
		)
		expect(at(open, home).wrongRegion).toBeNull()
	})
})
