import { BillingCustomer, BillingProfile } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { Message } from "./model"
import { Message as DetailsMessage } from "./details/model"
import { init, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const customer = Schema.decodeUnknownSync(BillingCustomer)({
	id: "org_acme",
	subscriptions: [{ planId: "startup", status: "active", currentPeriodStart: 0, currentPeriodEnd: 30 * 86_400_000 }],
})

const profile = Schema.decodeUnknownSync(BillingProfile)({
	linked: true,
	name: "Acme Shop Ltd",
	address: { line1: "1 Market Street", city: "London", postalCode: "EC1A 1BB", country: "GB" },
	taxIds: [],
})

describe("billing tab", () => {
	test("reads the catalog, usage, daily spend, invoices and billing details", () => {
		expect(names(init(true).commands)).toEqual([
			"FetchBillingPlans",
			"FetchBillingUsage",
			"FetchBillingDailySpend",
			"FetchBillingInvoices",
			"FetchBillingProfile",
		])
	})

	test("a cap is saved for the open row, and the save reads the customer and daily spend again", () => {
		const editing = update(init(true).model, Message.ClickedEditCap({ featureId: "logs" }), customer, 0).step.model
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
		const editing = update(init(true).model, Message.ClickedEditCap({ featureId: "traces" }), customer, 0).step.model
		const typed = update(editing, Message.ChangedCap({ value: "1e3" }), customer, 0).step.model
		expect(update(typed, Message.ClickedSaveCap(), customer, 0).step.commands ?? []).toEqual([])
	})

	test("billing details open on the profile on file and save every address line", () => {
		const loaded = update(init(true).model, Message.CompletedFetchProfile({ result: Result.succeed(profile) }), customer, 0)
			.step.model
		const opened = update(loaded, Message.ClickedEditDetails(), customer, 0).step.model
		expect(opened.details.name).toBe("Acme Shop Ltd")
		const renamed = update(
			opened,
			Message.GotDetailsMessage({ message: DetailsMessage.ChangedField({ field: "name", value: "Acme Retail Ltd" }) }),
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
					address: { line1: "1 Market Street", line2: null, city: "London", postalCode: "EC1A 1BB", country: "GB" },
				},
			},
		})
	})
})
