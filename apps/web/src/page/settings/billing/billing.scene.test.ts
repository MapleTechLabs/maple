import { AttachResult, BillingCustomer, BillingProfile } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { Message } from "./model"
import { Message as DetailsMessage } from "./details/model"
import { customerChanged, init, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const customer = Schema.decodeUnknownSync(BillingCustomer)({
	id: "org_acme",
	subscriptions: [
		{ planId: "startup", status: "active", currentPeriodStart: 0, currentPeriodEnd: 30 * 86_400_000 },
	],
})

const profile = Schema.decodeUnknownSync(BillingProfile)({
	linked: true,
	name: "Acme Shop Ltd",
	address: { line1: "1 Market Street", city: "London", postalCode: "EC1A 1BB", country: "GB" },
	taxIds: [],
})

describe("billing tab", () => {
	test("reads the catalog, usage, daily spend, invoices and billing details", () => {
		expect(names(init(true, false).commands)).toEqual(
			expect.arrayContaining([
				"FetchBillingPlans",
				"FetchBillingUsage",
				"FetchBillingDailySpend",
				"FetchBillingInvoices",
				"FetchBillingProfile",
			]),
		)
	})

	test("a cap is saved for the open row, and the save reads the customer and daily spend again", () => {
		const editing = update(
			init(true, false).model,
			Message.ClickedEditCap({ featureId: "logs" }),
			customer,
			0,
		).step.model
		const typed = update(editing, Message.ChangedCap({ value: "50" }), customer, 0).step.model
		expect(update(typed, Message.ClickedSaveCap(), customer, 0).step.commands?.[0]).toMatchObject({
			name: "UpdateBillingControls",
			args: { featureId: "logs", overageLimit: 50 },
		})
		const saved = update(
			{ ...typed, isSavingCap: true },
			Message.CompletedSaveCap({ featureId: "logs", label: "Logs", result: Result.succeed(customer) }),
			customer,
			0,
		)
		expect(saved.isCustomerStale).toBe(true)
		expect(names(saved.step.commands)).toEqual(["FetchBillingDailySpend"])
		expect(saved.step.model.editingCap).toBeNull()
	})

	test("text that is not a number keeps the cap editor from saving", () => {
		const editing = update(
			init(true, false).model,
			Message.ClickedEditCap({ featureId: "traces" }),
			customer,
			0,
		).step.model
		const typed = update(editing, Message.ChangedCap({ value: "1e3" }), customer, 0).step.model
		expect(update(typed, Message.ClickedSaveCap(), customer, 0).step.commands ?? []).toEqual([])
	})

	test("billing details open on the profile on file and save every address line", () => {
		const loaded = update(
			init(true, false).model,
			Message.CompletedFetchProfile({ result: Result.succeed(profile) }),
			customer,
			0,
		).step.model
		const opened = update(loaded, Message.ClickedEditDetails(), customer, 0).step.model
		expect(opened.details.name).toBe("Acme Shop Ltd")
		const renamed = update(
			opened,
			Message.GotDetailsMessage({
				message: DetailsMessage.ChangedField({ field: "name", value: "Acme Retail Ltd" }),
			}),
			customer,
			0,
		).step.model
		const submitted = update(
			renamed,
			Message.GotDetailsMessage({ message: DetailsMessage.SubmittedDetails() }),
			customer,
			0,
		).step.commands?.[0]
		expect(submitted).toMatchObject({
			name: "UpdateBillingProfile",
			args: {
				payload: {
					name: "Acme Retail Ltd",
					address: {
						line1: "1 Market Street",
						line2: null,
						city: "London",
						postalCode: "EC1A 1BB",
						country: "GB",
					},
				},
			},
		})
	})

	test("a return from Stripe polls the customer until it carries the plan, then clears the marker", () => {
		const returning = init(true, true)
		expect(returning.model.checkoutReturn).toBe("Confirming")
		expect(names(returning.commands)).toEqual(
			expect.arrayContaining(["WaitBillingCheckoutPoll", "WaitBillingCheckoutTimeout"]),
		)
		const polled = update(returning.model, Message.ElapsedCheckoutPoll(), null, 0)
		expect(polled.isCustomerStale).toBe(true)
		expect(names(polled.step.commands)).toEqual(["WaitBillingCheckoutPoll"])
		const planless = new BillingCustomer({ id: "org_acme", subscriptions: [] })
		expect(customerChanged(returning.model, planless)).toBeNull()
		const confirmed = customerChanged(returning.model, customer)
		expect(confirmed?.checkout).toBe("Confirmed")
		expect(confirmed?.step.model.checkoutReturn).toBe("Idle")
		expect(confirmed?.step.commands?.[0]).toMatchObject({
			args: { event: "plan_checkout_returned", props: { confirmed: true } },
		})
	})

	test("the wait gives up after the timeout with the notice, and an idle tab never polls", () => {
		const timedOut = update(init(true, true).model, Message.ElapsedCheckoutTimeout(), null, 0)
		expect(timedOut.step.model.checkoutReturn).toBe("TimedOut")
		expect(timedOut.checkout).toBe("TimedOut")
		expect(update(timedOut.step.model, Message.ElapsedCheckoutPoll(), null, 0).isCustomerStale).toBe(
			false,
		)
		expect(names(init(true, false).commands)).not.toContain("WaitBillingCheckoutPoll")
	})

	test("a checkout link records plan_checkout_started before the redirect", () => {
		const attaching = update(
			init(true, false).model,
			Message.ClickedSubscribe({ planId: "startup" }),
			null,
			0,
		).step.model
		const attached = update(
			attaching,
			Message.CompletedAttach({
				planId: "startup",
				result: Result.succeed(new AttachResult({ paymentUrl: "https://checkout.stripe.com/x" })),
			}),
			null,
			0,
		)
		// oxlint-disable-next-line test-slop/no-exact-name-list -- tracking must run before the redirect unloads the page
		expect(attached.step.commands?.map((command) => command.name)).toEqual([
			"TrackBillingCheckout",
			"RedirectToBilling",
		])
		expect(attached.step.commands?.[0]).toMatchObject({
			args: { event: "plan_checkout_started", props: { plan_id: "startup" } },
		})
	})
})
