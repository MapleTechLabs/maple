import { OrgId } from "@maple/domain"
import { AlertDestinationId } from "@maple/domain/http"
import { Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import * as Select from "@maple/views/ui/select"
import type { PageContext } from "../../contract"
import { chainDestinations, chainUuid, populatedChains } from "../shared/escalation-test-fixtures"
import { destinationRow, NOW, ORG, ruleRow } from "../shared/test-rows"
import { chainSelectIdOf } from "./form-steps"
import { init } from "./init"
import { Message, type Tier } from "./message"
import type { Model } from "./model"
import { saveIssues } from "./derive"
import { update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const CHAINS = populatedChains([])
const issuesOf = (model: Model) => (model.form === null ? ["no draft"] : saveIssues(model.form, null))
const pickChain = (tier: Tier, value: string) =>
	Message.GotSelectMessage({
		id: chainSelectIdOf(tier),
		message: Select.Message.SelectedItem({ index: 1, value }),
	})

/** A slow-p95 draft on the org's default destination, with the org's chains read. */
const ready = () => {
	const start = init({ _tag: "AlertsCreate", search: { template: "slow_p95" } }, context)
	expect(names(start.commands)).toContain("FetchAlertEditorChains")
	return run(start.model, [
		Message.GeneratedDraftId({ id: "6f1c2e3a-0000-4000-8000-000000000001" }),
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow(), ...chainDestinations] }),
		Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
		Message.CompletedFetchEscalationChains({ chains: CHAINS }),
	])
}
const withoutDestination = (model: Model) =>
	run(model, [
		Message.ClickedRemoveDestination({
			tier: "warning",
			id: Schema.decodeSync(AlertDestinationId)(destinationRow().id),
		}),
	])

describe("alert rule editor, escalation chains", () => {
	test("each tier offers None and the org's chains, with a link to create one", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready()),
			themeResolved(),
			expectView(role("combobox", { name: "Escalation chain" })).toExist(),
			expectView(role("link", { name: "Create a chain" })).toHaveAttr("href", "/alerts?tab=routing"),
		)
	})

	test("a two-tier rule names each picker by its tier", () => {
		scene(
			{ update: pageUpdate, view },
			given(run(ready(), [Message.ClickedAddCriticalTier()])),
			themeResolved(),
			expectView(role("combobox", { name: "Warning escalation chain" })).toExist(),
			expectView(role("combobox", { name: "Critical escalation chain" })).toExist(),
			expectView(role("combobox", { name: "Escalation chain" })).not.toExist(),
		)
	})

	test("a tier with neither a destination nor a chain says so and cannot be saved", () => {
		const model = withoutDestination(ready())
		expect(issuesOf(model)).toContain("Who gets notified")
		expect(names(pageUpdate(model, Message.ClickedSave()).commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Pick a destination or an escalation chain")).toExist(),
		)
	})

	test("a chain alone routes the tier, and its steps read under the picker", () => {
		const model = run(withoutDestination(ready()), [pickChain("warning", chainUuid(1))])
		expect(model.form?.escalationChainId).toBe(chainUuid(1))
		expect(issuesOf(model)).not.toContain("Who gets notified")
		expect(names(pageUpdate(model, Message.ClickedSave()).commands)).toEqual(["SaveAlertRule"])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text(/^Slack #alerts-api, then PagerDuty Checkout after 10m/u)).toExist(),
			expectView(text("Pick a destination or an escalation chain")).not.toExist(),
		)
		expect(run(model, [pickChain("warning", "none")]).form?.escalationChainId).toBeNull()
	})

	test("a failed chain read keeps the tier's chain and says the list did not load, not that the chain is gone", () => {
		const model = run(ready(), [
			pickChain("warning", chainUuid(1)),
			Message.CompletedFetchEscalationChains({ chains: null }),
		])
		expect(model.form?.escalationChainId).toBe(chainUuid(1))
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Couldn't load escalation chains; reload the page to change this one")).toExist(),
			expectView(text("Unavailable chain")).not.toExist(),
		)
	})

	test("a failed chain read says so on a tier with no chain, rather than looking like the org has none", () => {
		scene(
			{ update: pageUpdate, view },
			given(run(ready(), [Message.CompletedFetchEscalationChains({ chains: null })])),
			themeResolved(),
			expectView(text("Couldn't load escalation chains; reload the page to pick one")).toExist(),
		)
	})

	test("returning to the tab reads the chains again, so one made in the Create a chain tab can be picked", () => {
		expect(names(pageUpdate(ready(), Message.ReturnedToTab()).commands)).toEqual([
			"FetchAlertEditorChains",
		])
	})

	test("the critical tier needs a destination or a chain of its own", () => {
		const tiered = run(ready(), [Message.ClickedAddCriticalTier()])
		expect(issuesOf(tiered)).toContain("Critical destinations")
		const routed = run(tiered, [pickChain("critical", chainUuid(2))])
		expect(routed.form?.escalation?.escalationChainId).toBe(chainUuid(2))
		expect(issuesOf(routed)).not.toContain("Critical destinations")
	})
})
