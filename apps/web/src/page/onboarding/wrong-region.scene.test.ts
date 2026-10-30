import { OrgId } from "@maple/domain"
import { Option } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { ClerkOrganization } from "../../platform/clerk"
import { AppRoute } from "../../route"
import { init, type Inputs, update } from "./index"
import { initCustomer, leaveTargetOf } from "./plan-gate"
import { view } from "./view"

const organization: ClerkOrganization = {
	id: OrgId.make("org_eu"),
	name: "Acme EU",
	imageUrl: "",
	homeRegion: "eu",
	isServedHere: false,
	isRegionOpen: false,
	flags: { aiAutoTriage: false, releases: false, securityAudit: false },
}

const usOrganization: ClerkOrganization = {
	...organization,
	id: OrgId.make("org_us"),
	name: "Acme US",
	homeRegion: "us",
	isServedHere: true,
}

const inputs: Inputs = {
	session: "SignedIn",
	maybeOrgId: Option.some(organization.id),
	maybeOrganization: Option.some(organization),
	memberships: [organization, usOrganization],
	maybeUser: Option.none(),
	customer: initCustomer(),
	timeZone: "UTC",
	maybePendingTask: Option.none(),
}

describe("wrong-region screen", () => {
	test("an org another region serves names its region and offers to switch", () => {
		const route = AppRoute.Traces({ search: {} })
		const step = Option.getOrThrow(init(route, "WrongRegion:/traces", inputs))
		expect(step.model.screen).toEqual({
			_tag: "WrongRegion",
			region: "eu",
			href: "/traces",
			isLeaving: false,
		})
		expect(step.commands).toEqual([])
		scene(
			{
				update: (model, message) => update(model, message, inputs),
				view: withViewInputs(view, inputs)(),
			},
			given(step.model),
			expectView(role("heading", { name: "Acme EU is in the EU region" })).toExist(),
			expectView(role("button", { name: "Switch organization" })).toExist(),
		)
	})

	test("a user with no org in this region goes to the org's region on the same page", () => {
		const euUrl = (region: string) => (region === "eu" ? "https://app.eu.maple.dev" : undefined)
		expect(leaveTargetOf("eu", "/traces", [organization], euUrl)).toBe("https://app.eu.maple.dev/traces")
		expect(leaveTargetOf("eu", "/traces", [organization, usOrganization], euUrl)).toBeNull()
		// Without the region's URL the screen stays, with its own "Open in" link gone too.
		expect(leaveTargetOf("eu", "/traces", [organization], () => undefined)).toBeNull()
	})
})
