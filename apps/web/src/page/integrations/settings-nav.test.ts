import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { visibleSections, visibleTabs } from "../settings/nav"
import { settingsNavVisibility } from "./derive"
import { Message } from "./message"
import { init, update } from "./update"

const ADMIN = Policy.grantsOf(["org:admin"])

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const clerkTabs = (model: Parameters<typeof settingsNavVisibility>[0]) =>
	visibleTabs(visibleSections(settingsNavVisibility(model, true)))

describe("integrations settings rail", () => {
	test("under Clerk a member sees the account tabs and no admin-only rows", () => {
		const model = { ...init({ search: {} }, context).model, grants: [] }
		const tabs = clerkTabs(model)
		expect(tabs).toContain("general")
		expect(tabs).toContain("members")
		expect(tabs).not.toContain("audit-log")
		expect(tabs).not.toContain("ai")
		expect(tabs).not.toContain("data-platform")
	})

	test("the session answer turns on the admin rows; data platform still waits on the add-on", () => {
		const model = { ...init({ search: {} }, context).model, grants: [] }
		const next = update(model, Message.CompletedLoadSession({ grants: ADMIN }), context).model
		const tabs = clerkTabs(next)
		expect(tabs).toContain("audit-log")
		expect(tabs).toContain("ai")
		expect(tabs).not.toContain("data-platform")
	})

	test("an engineer gets the setup rows but not the admin-only audit log or AI", () => {
		const model = { ...init({ search: {} }, context).model, grants: [] }
		const next = update(
			model,
			Message.CompletedLoadSession({ grants: Policy.grantsOf(["org:engineer"]) }),
			context,
		).model
		const tabs = clerkTabs(next)
		expect(tabs).toContain("ingestion")
		expect(tabs).not.toContain("audit-log")
		expect(tabs).not.toContain("ai")
	})

	test("self-hosted shows every self-hosted row", () => {
		const model = init({ search: {} }, context).model
		const tabs = visibleTabs(visibleSections(settingsNavVisibility(model, false)))
		expect(tabs).toContain("data-platform")
		expect(tabs).not.toContain("general")
	})
})
