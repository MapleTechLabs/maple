import { OrgId } from "@maple/domain"
import { Option } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { ClerkOrganization } from "../../platform/clerk"
import { AppRoute } from "../../route"
import { init, type Inputs, update } from "./index"
import { initCustomer } from "./plan-gate"
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

const inputs: Inputs = {
	session: "SignedIn",
	maybeOrgId: Option.some(organization.id),
	maybeOrganization: Option.some(organization),
	memberships: [organization],
	maybeUser: Option.none(),
	customer: initCustomer(),
}

describe("wrong-region screen", () => {
	test("an org another region serves names its region and offers to switch", () => {
		const route = AppRoute.Traces({ search: {} })
		const step = Option.getOrThrow(init(route, "WrongRegion:/traces", inputs))
		expect(step.model.screen).toEqual({ _tag: "WrongRegion", region: "eu", href: "/traces" })
		scene(
			{ update: (model, message) => update(model, message, inputs), view: withViewInputs(view, inputs)() },
			given(step.model),
			expectView(role("heading", { name: "Acme EU is in the EU region" })).toExist(),
			expectView(role("button", { name: "Switch organization" })).toExist(),
		)
	})
})
