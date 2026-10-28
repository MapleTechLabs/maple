import { BillingAccount, BillingAccountUsageResponse, BillingCustomer } from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import { AsyncData } from "foldkit"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { toLoadFailure } from "../../../data/load-failure"
import { view as billingView } from "./view"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const NOW = 10 * 86_400_000
const customer = Schema.decodeUnknownSync(BillingCustomer)({
	id: "org_acme",
	subscriptions: [
		{ planId: "startup", status: "active", currentPeriodStart: 0, currentPeriodEnd: 30 * 86_400_000 },
	],
})
const orgId = Schema.decodeSync(OrgId)

const account = (input: unknown) => Schema.decodeUnknownSync(BillingAccount)(input)
const acme = { orgId: "org_acme", name: "Acme", imageUrl: null }
const member = account({ orgId: "org_member", role: "member", billingOrg: acme, members: [] })
const standalone = account({
	orgId: "org_side",
	role: "standalone",
	billingOrg: { ...acme, orgId: "org_side" },
	members: [],
})
const payer = account({
	orgId: "org_acme",
	role: "billing_org",
	billingOrg: acme,
	members: [
		{ orgId: "org_staging", name: "Acme Staging", imageUrl: null, linkedAt: 0 },
		{ orgId: "org_eu", name: "Acme EU", imageUrl: null, linkedAt: 86_400_000 },
	],
})

const step = (model: Model, message: Message) => update(model, message, customer, NOW).step
const run = (model: Model, ...messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => step(current, message).model, model)

const view = withViewInputs(billingView, {
	customer: AsyncData.Success({ data: customer }),
	adminName: null,
	isKnownMember: false,
	nowMs: NOW,
	timeZone: "UTC",
})()

const accountRead = (value: BillingAccount) =>
	Message.CompletedFetchAccount({ result: Result.succeed(value) })

describe("billing account", () => {
	test("a member org shows who pays and never asks for invoices or billing details", () => {
		const entered = init(true, false, true)
		expect(names(entered.commands)).toContain("FetchBillingAccount")
		expect(names(entered.commands)).not.toContain("FetchBillingInvoices")
		const read = step(entered.model, accountRead(member))
		expect(names(read.commands)).not.toEqual(
			expect.arrayContaining(["FetchBillingInvoices", "FetchBillingProfile"]),
		)
		scene(
			{ update: step, view },
			given(read.model),
			expectView(text("Billed through Acme")).toExist(),
			expectView(role("button", { name: "Stop billing through Acme" })).toExist(),
			expectView(text("Invoices")).not.toExist(),
		)
	})

	test("offers no billing controls before it knows who pays", () => {
		scene(
			{ update: step, view },
			given(init(true, false, true).model),
			expectView(role("button", { name: "Manage billing" })).not.toExist(),
			expectView(text("Compare plans")).not.toExist(),
		)
	})

	test("reads the account again when a link fails for an unexplained reason", () => {
		const read = run(init(true, false, true).model, accountRead(standalone))
		const failed = step(
			read,
			Message.CompletedLink({
				orgName: "Acme",
				result: Result.fail({ rejection: null, failure: toLoadFailure(new Error("timeout")) }),
			}),
		)
		expect(names(failed.commands)).toContain("FetchBillingAccount")
	})

	test("a member org's non-admin sees who pays with no way to change it", () => {
		const read = run(init(false, false, true).model, accountRead(member))
		scene(
			{ update: step, view },
			given(read),
			expectView(text("Billed through Acme")).toExist(),
			expectView(role("button", { name: "Stop billing through Acme" })).not.toExist(),
		)
	})

	test("a member admin stops billing through the payer after confirming", () => {
		const read = run(init(true, false, true).model, accountRead(member))
		const opened = step(read, Message.ClickedUnlink({ orgId: orgId("org_acme") }))
		const confirmed = step(opened.model, Message.ClickedConfirmUnlink())
		expect(confirmed.commands?.[0]).toMatchObject({
			name: "UnlinkBillingOrg",
			// Its own org: the payer has no link to remove.
			args: { orgId: "org_member", isSelf: true },
		})
		const done = update(
			confirmed.model,
			Message.CompletedUnlink({ isSelf: true, result: Result.succeed(standalone) }),
			customer,
			NOW,
		)
		expect(done.isCustomerStale).toBe(true)
		expect(names(done.step.commands)).toEqual(
			expect.arrayContaining(["FetchBillingInvoices", "FetchBillingProfile", "FetchBillingOrgChoices"]),
		)
	})

	test("a billing org lists the orgs it pays for with this cycle's volume", () => {
		const read = step(init(true, false, true).model, accountRead(payer))
		expect(names(read.commands)).toEqual(
			expect.arrayContaining([
				"FetchBillingInvoices",
				"FetchBillingProfile",
				"FetchBillingAccountUsage",
			]),
		)
		const usage = Schema.decodeUnknownSync(BillingAccountUsageResponse)({
			cycleStartMs: 0,
			cycleEndMs: 30 * 86_400_000,
			orgs: [
				{
					orgId: "org_acme",
					logsGB: 40,
					tracesGB: 10,
					metricsGB: 0,
					browserSessions: 0,
					productEvents: 0,
				},
				{
					orgId: "org_staging",
					logsGB: 2,
					tracesGB: 0.5,
					metricsGB: 0,
					browserSessions: 0,
					productEvents: 0,
				},
				{
					orgId: "org_eu",
					logsGB: 12,
					tracesGB: 0,
					metricsGB: 0,
					browserSessions: 340,
					productEvents: 0,
				},
			],
		})
		const loaded = run(read.model, Message.CompletedFetchAccountUsage({ result: Result.succeed(usage) }))
		scene(
			{ update: step, view },
			given(loaded),
			expectView(text("Billed organizations")).toExist(),
			expectView(text("Acme Staging")).toExist(),
			expectView(text("2.50 GB")).toExist(),
			expectView(text("12.00 GB · 340 sessions")).toExist(),
			expectView(role("button", { name: "Remove Acme EU from billing" })).toExist(),
		)
		const removing = run(loaded, Message.ClickedUnlink({ orgId: orgId("org_eu") }))
		expect(step(removing, Message.ClickedConfirmUnlink()).commands?.[0]).toMatchObject({
			name: "UnlinkBillingOrg",
			args: { orgId: "org_eu", isSelf: false },
		})
	})

	test("a standalone admin picks another org and links billing to it", () => {
		const read = step(init(true, false, true).model, accountRead(standalone))
		expect(names(read.commands)).toContain("FetchBillingOrgChoices")
		const choices = run(
			read.model,
			Message.CompletedFetchOrgChoices({
				result: Result.succeed([
					{ orgId: orgId("org_acme"), name: "Acme", imageUrl: "" },
					{ orgId: orgId("org_globex"), name: "Globex", imageUrl: "" },
				]),
			}),
		)
		scene(
			{ update: step, view },
			given(choices),
			expectView(text("Bill through another organization")).toExist(),
			expectView(role("button", { name: "Bill through Acme" })).toExist(),
		)
		const picked = run(choices, Message.ChangedLinkOrg({ value: "org_globex" }), Message.ClickedLink())
		expect(picked.linkDialog.isOpen).toBe(true)
		const confirmed = step(picked, Message.ClickedConfirmLink())
		expect(confirmed.commands?.[0]).toMatchObject({
			name: "LinkBillingOrg",
			args: { billingOrgId: "org_globex", orgName: "Globex" },
		})
		const linked = update(
			confirmed.model,
			Message.CompletedLink({ orgName: "Globex", result: Result.succeed(member) }),
			customer,
			NOW,
		)
		expect(linked.isCustomerStale).toBe(true)
		expect(linked.step.model.invoices).toEqual(AsyncData.Idle())
	})

	test("a refused link shows the server's reason in the section", () => {
		const choices = run(
			init(true, false, true).model,
			accountRead(standalone),
			Message.CompletedFetchOrgChoices({
				result: Result.succeed([{ orgId: orgId("org_acme"), name: "Acme", imageUrl: "" }]),
			}),
			Message.ClickedConfirmLink(),
			Message.CompletedLink({
				orgName: "Acme",
				result: Result.fail({
					rejection: "Billing through another organization isn't enabled for Acme yet.",
					failure: toLoadFailure(new Error("refused")),
				}),
			}),
		)
		scene(
			{ update: step, view },
			given(choices),
			expectView(text("Billing through another organization isn't enabled for Acme yet.")).toExist(),
		)
	})

	test("without other orgs to pick, or for a non-admin, the link section stays hidden", () => {
		const empty = run(
			init(true, false, true).model,
			accountRead(standalone),
			Message.CompletedFetchOrgChoices({ result: Result.succeed([]) }),
		)
		scene(
			{ update: step, view },
			given(empty),
			expectView(text("Bill through another organization")).not.toExist(),
		)
		expect(names(step(init(false, false, true).model, accountRead(standalone)).commands)).not.toContain(
			"FetchBillingOrgChoices",
		)
		expect(names(step(init(true, false, false).model, accountRead(standalone)).commands)).not.toContain(
			"FetchBillingOrgChoices",
		)
	})
})
