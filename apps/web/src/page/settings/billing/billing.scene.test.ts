import { AttachResult, BillingCustomer, BillingProfile } from "@maple/domain/http"
import { V2IngestRuleStats } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { Submodel } from "foldkit"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { Message, type Model } from "./model"
import { Message as DetailsMessage } from "./details/model"
import { customerChanged, init, requestRuleStats, revisit, spendModelOf, update } from "./update"
import { usageTable } from "./view-usage"
import { toLoadFailure } from "../../../data/load-failure"

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

const NOW = 10 * 86_400_000

/** The usage table alone; the tab around it has its own tests. */
const usageView = Submodel.defineView<Model, Message, Readonly<{ readonly none?: never }>>(
	(model, _inputs, h) => {
		const spend = spendModelOf(model, customer, NOW)
		return spend === null ? h.div([], []) : usageTable(h, model, spend, customer)
	},
)
const view = withViewInputs(usageView, {})()
const step = (model: Model, message: Message) => update(model, message, customer, NOW).step

describe("billing tab", () => {
	test("once the cycle is known, the rule stats are read from its start, once", () => {
		const requested = requestRuleStats(init(true, false).model, customer, NOW)
		expect(requested?.commands?.[0]).toMatchObject({
			name: "FetchBillingRuleStats",
			args: { startMs: 0 },
		})
		expect(requestRuleStats(init(true, false).model, null, NOW)).toBeNull()
		expect(requested === null ? null : requestRuleStats(requested.model, customer, NOW)).toBeNull()
	})

	test("a failed rule stats read is asked for again when the tab is revisited", () => {
		const requested = requestRuleStats(init(true, false).model, customer, NOW)
		expect(requested).not.toBeNull()
		if (requested === null) return
		const failed = step(
			requested.model,
			Message.CompletedFetchRuleStats({ result: Result.fail(toLoadFailure(new Error("boom"))) }),
		)
		expect(requestRuleStats(failed.model, customer, NOW)).toBeNull()
		expect(names(requestRuleStats(revisit(failed.model).model, customer, NOW)?.commands)).toEqual([
			"FetchBillingRuleStats",
		])
	})

	test("a signal with bytes dropped by rules says so under its usage", () => {
		const stats = Schema.decodeUnknownSync(V2IngestRuleStats)({
			object: "ingest_rule_stats",
			start_time: "1970-01-01T00:00:00.000Z",
			end_time: "1970-01-11T00:00:00.000Z",
			rules: [],
			signals: [
				{
					signal: "logs",
					matched: 10,
					dropped: 10,
					dropped_bytes: 2_500_000_000,
					redacted_values: 0,
				},
				{ signal: "traces", matched: 3, dropped: 0, dropped_bytes: 0, redacted_values: 3 },
			],
			hourly: [],
		})
		scene(
			{ update: step, view },
			given(
				step(
					init(true, false).model,
					Message.CompletedFetchRuleStats({ result: Result.succeed(stats) }),
				).model,
			),
			expectView(text("2.50 GB dropped by rules, not billed")).toExist(),
			expectView(text(/0.00 GB dropped by rules/u)).not.toExist(),
		)
	})

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
