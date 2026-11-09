import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { EscalationChainId } from "@maple/domain/http"
import { EscalationChainPublicId } from "@maple/domain/http/v2"
import { Option, Result, Schema, Array as Arr } from "effect"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { CHAIN_IN_USE_CODE } from "../shared/escalation-chains"
import {
	chainDestinations,
	chainDestinationUuid,
	chainUuid,
	populatedChains,
} from "../shared/escalation-test-fixtures"
import { ORG, ruleId, ruleRow } from "../shared/test-rows"
import { payloadOf } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const RULES = [ruleRow(1, { name: "Checkout errors" }), ruleRow(2, { name: "Checkout p95" }), ruleRow(3)]
const CHAINS = populatedChains([ruleId(1), ruleId(2), ruleId(3)])
const chainPublicId = (n: number) =>
	Schema.encodeSync(EscalationChainPublicId)(Schema.decodeSync(EscalationChainId)(chainUuid(n)))

const pick = (key: string, value: string) =>
	Message.GotMenuMessage({
		kind: "targets",
		key,
		message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value } },
	})
const act = (key: string, value: string) =>
	Message.GotMenuMessage({
		kind: "actions",
		key,
		message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value } },
	})

const ready = (route: Parameters<typeof init>[0]) => {
	const entered = init(route, context)
	return run(entered.model, [
		Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
		Message.CompletedFetchMembers({ result: Result.succeed([]) }),
		Message.CompletedFetchSchedules({ result: Result.succeed([]) }),
		Message.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
		Message.UpdatedRules({ orgId: ORG, rows: RULES }),
	])
}
const newChain = (returnTo?: string) =>
	ready({ _tag: "AlertsEscalationChainNew", search: returnTo === undefined ? {} : { returnTo } })

const editing = (n: number) => {
	const base = ready({ _tag: "AlertsEscalationChain", chainId: chainPublicId(n), search: {} })
	const chain = CHAINS[n - 1]
	return chain === undefined
		? base
		: run(base, [
				Message.CompletedFetchExisting({
					key: base.existing.key ?? "",
					result: Result.succeed(chain),
				}),
			])
}

describe("escalation chain editor", () => {
	test("a new chain reads as a sentence from the start card to the end card", () => {
		scene(
			{ update: pageUpdate, view },
			given(newChain()),
			expectView(text("New escalation chain")).toExist(),
			expectView(text("When an alert escalates to this chain")).toExist(),
			expectView(text("Notify")).toExist(),
			expectView(text("minutes for an acknowledgement")).toExist(),
			expectView(text("If nobody acknowledges, repeat the chain")).toExist(),
			expectView(role("link", { name: "Cancel" })).toHaveAttr("href", "/alerts/routing"),
			expectView(role("button", { name: "Create chain" })).toExist(),
		)
	})

	test("builds a chain: add steps, insert between, reorder, remove, then save", () => {
		const first = run(newChain(), [
			Message.ChangedName({ value: "Checkout on-call" }),
			pick("s0", `destination:${chainDestinationUuid(1)}`),
			Message.ClickedInsertStep({ index: 1 }),
			pick("s1", `destination:${chainDestinationUuid(2)}`),
			Message.ChangedWait({ key: "s0", value: "5" }),
		])
		expect(Arr.map(first.form.steps, (step) => step.key)).toEqual(["s0", "s1"])
		// The + between the two cards puts a new step in the middle.
		scene(
			{ update: pageUpdate, view },
			given(first),
			click(role("button", { name: "Add a step after step 1" })),
			expectView(role("button", { name: "Actions for step 3" })).toExist(),
		)
		const middle = pageUpdate(first, Message.ClickedInsertStep({ index: 1 })).model
		expect(Arr.map(middle.form.steps, (step) => step.key)).toEqual(["s0", "s2", "s1"])
		const reordered = run(middle, [act("s1", "up"), act("s1", "up"), act("s2", "remove")])
		expect(Arr.map(reordered.form.steps, (step) => step.key)).toEqual(["s1", "s0"])
		const saved = pageUpdate(reordered, Message.ClickedSave())
		expect(names(saved.commands)).toEqual(["SaveEscalationChainFromEditor"])
		expect(
			Option.map(payloadOf(reordered.form), (payload) => Arr.map(payload.steps, (s) => s.wait_minutes)),
		).toEqual(Option.some([10, 5]))
		const chain = CHAINS[0]
		if (chain === undefined) throw new Error("fixture chain missing")
		const done = pageUpdate(saved.model, Message.CompletedSave({ result: Result.succeed(chain) }))
		expect(done.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: `/alerts/escalation-chains/${chainPublicId(1)}`,
			toast: { title: "Escalation chain created" },
		})
	})

	test("saving with missing fields shows each problem and sends nothing", () => {
		scene(
			{ update: pageUpdate, view },
			given(newChain()),
			click(role("button", { name: "Create chain" })),
			expectView(text("Name the chain")).toExist(),
			expectView(text("Pick at least one destination, person or schedule")).toExist(),
		)
		expect(names(pageUpdate(newChain(), Message.ClickedSave()).commands)).toEqual([])
	})

	test("an existing chain fills the form, previews itself and lists the rules that use it", () => {
		const model = editing(1)
		expect(model.form.name).toBe("Checkout on-call")
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Used by 2 rules")).toExist(),
			expectView(role("link", { name: "Checkout errors" })).toExist(),
			expectView(
				text(
					"Slack #alerts-api, then PagerDuty Checkout after 10m, then Email on-call after 15m; repeats twice",
				),
			).toExist(),
			expectView(role("button", { name: "Save chain" })).toExist(),
		)
		expect(names(pageUpdate(model, Message.ClickedSave()).commands)).toEqual([
			"SaveEscalationChainFromEditor",
		])
	})

	test("delete lists the rules that would stop escalating and holds the delete while they use it", () => {
		const asked = pageUpdate(editing(1), Message.ClickedDelete()).model
		expect(asked.deleteDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(asked),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text(/These rules would stop escalating/u)).toExist(),
			expectView(text("Checkout p95")).toExist(),
		)
		// A stale page still gets the API's refusal as a message in the dialog.
		const refused = pageUpdate(
			{ ...asked, isDeleting: true },
			Message.CompletedDelete({
				result: Result.fail({
					_tag: "@maple/http/errors/EscalationChainInUseError",
					type: "conflict_error",
					code: CHAIN_IN_USE_CODE,
					title: "Escalation chain is in use",
					message: "The escalation chain is used by one or more alert rules.",
					retryable: false,
					recovery: "fix_request",
				}),
			}),
		)
		expect(refused.model.deleteError).toMatch(/Remove it from the rule's severity tiers first/u)
	})

	test("an unused chain deletes and goes back to Routing", () => {
		const unused = editing(2)
		const confirmed = pageUpdate(
			pageUpdate(unused, Message.ClickedDelete()).model,
			Message.ClickedConfirmDelete(),
		)
		expect(names(confirmed.commands)).toEqual(["DeleteEscalationChainFromEditor"])
		const done = pageUpdate(confirmed.model, Message.CompletedDelete({ result: Result.void }))
		expect(done.outMessage).toMatchObject({ _tag: "RequestedNavigation", url: "/alerts/routing" })
	})

	test("Cancel and Save go back to an in-app returnTo, never another origin", () => {
		scene(
			{ update: pageUpdate, view },
			given(newChain("/alerts/create")),
			expectView(role("link", { name: "Cancel" })).toHaveAttr("href", "/alerts/create"),
		)
		scene(
			{ update: pageUpdate, view },
			given(newChain("https://evil.example")),
			expectView(role("link", { name: "Cancel" })).toHaveAttr("href", "/alerts/routing"),
		)
		const filled = run(newChain("/alerts/create"), [
			Message.ChangedName({ value: "On-call" }),
			pick("s0", `destination:${chainDestinationUuid(1)}`),
		])
		const saving = pageUpdate(filled, Message.ClickedSave()).model
		const chain = CHAINS[0]
		if (chain === undefined) throw new Error("fixture chain missing")
		expect(
			pageUpdate(saving, Message.CompletedSave({ result: Result.succeed(chain) })).outMessage,
		).toMatchObject({
			url: "/alerts/create",
		})
	})

	test("a link with a malformed chain id says the chain was not found", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready({ _tag: "AlertsEscalationChain", chainId: "nope", search: {} })),
			expectView(text("Escalation chain not found")).toExist(),
		)
	})
})
