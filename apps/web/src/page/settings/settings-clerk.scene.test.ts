import { BillingCustomer } from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test, vi } from "vitest"
import type { PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

// Billing is a Clerk-only tab.
vi.mock("../../lib/services/common/auth-mode", () => ({ isClerkAuthEnabled: true }))

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const toTab = (model: Model, tab: NonNullable<Model["search"]["tab"]>) =>
	routeChanged(model, { _tag: "Settings", search: { tab } }, context)

const planless = new BillingCustomer({ id: "org_acme", subscriptions: [] })
const subscribed = Schema.decodeUnknownSync(BillingCustomer)({
	id: "org_acme",
	subscriptions: [{ planId: "startup", status: "active", currentPeriodStart: 0, currentPeriodEnd: 30 * 86_400_000 }],
})

describe("settings page (Clerk)", () => {
	test("a checkout return settles even when the Billing tab was left while it waited", () => {
		const returning = [
			Message.CompletedFetchSession({ result: Result.succeed({ isAdmin: true, userId: null, hasAiAutoTriage: false }) }),
			Message.CompletedFetchCustomer({ result: Result.succeed(planless) }),
		].reduce((model, message) => pageUpdate(model, message).model, init({ _tag: "Settings", search: { tab: "billing", checkout: "complete" } }, context).model)
		const away = toTab(returning, "mcp").model
		const settled = pageUpdate(away, Message.CompletedFetchCustomer({ result: Result.succeed(subscribed) }))
		const billing = settled.model.kept.find((tab) => tab._tag === "Billing")
		expect(billing?._tag === "Billing" && billing.model.checkoutReturn).toBe("Idle")
		expect(settled.commands).toContainEqual(
			expect.objectContaining({ args: { event: "plan_checkout_returned", props: { confirmed: true } } }),
		)
	})
})
