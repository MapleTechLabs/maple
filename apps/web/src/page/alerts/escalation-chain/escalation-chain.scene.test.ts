import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { EscalationChainId } from "@maple/domain/http"
import { EscalationChainPublicId } from "@maple/domain/http/v2"
import { Option, Result, Schema, Array as Arr } from "effect"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { triggerId } from "@maple/views/ui/overlay/popup-state"
import {
	click,
	Command,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	text,
	within,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { CHAIN_IN_USE_CODE, CHAIN_NOT_FOUND_CODE } from "../shared/escalation-chains"
import {
	chainDestinations,
	chainDestinationUuid,
	chainUuid,
	populatedChains,
} from "../shared/escalation-test-fixtures"
import { memberId, mixedTargetChain, oncallMembers, populatedSchedules } from "../shared/oncall-test-fixtures"
import { ORG, ruleId, ruleRow } from "../shared/test-rows"
import { FocusChainElement } from "./command"
import { payloadOf } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { init, insertButtonId, isBlockingNavigation, menuIdOf, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)
const keys = (model: Model) => Arr.map(model.form.steps, (step) => step.key)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])
const RULES = [ruleRow(1, { name: "Checkout errors" }), ruleRow(2, { name: "Checkout p95" }), ruleRow(3)]
const CHAINS = populatedChains([ruleId(1), ruleId(2), ruleId(3)])
const chainPublicId = (n: number) =>
	Schema.encodeSync(EscalationChainPublicId)(Schema.decodeSync(EscalationChainId)(chainUuid(n)))

const failureOf = (code: string, message: string): LoadFailure => ({
	_tag: "@maple/http/errors/EscalationChainError",
	type: code === CHAIN_IN_USE_CODE ? "conflict_error" : "not_found_error",
	code,
	title: "Escalation chain",
	message,
	retryable: false,
	recovery: "fix_request",
})
const IN_USE = failureOf(CHAIN_IN_USE_CODE, "The escalation chain is used by one or more alert rules.")
const GONE = failureOf(CHAIN_NOT_FOUND_CODE, "Escalation chain not found.")

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

const entered = (route: Parameters<typeof init>[0], grants = ENGINEER) =>
	run(init(route, context).model, [
		Message.CompletedFetchSession({ orgId: ORG, grants }),
		Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
		Message.CompletedFetchSchedules({ result: Result.succeed(populatedSchedules()) }),
		Message.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
		Message.UpdatedRules({ orgId: ORG, rows: RULES }),
	])
const newChain = (grants = ENGINEER) => entered({ _tag: "AlertsEscalationChainNew", search: {} }, grants)
const opening = (n: number, grants = ENGINEER) =>
	entered({ _tag: "AlertsEscalationChain", chainId: chainPublicId(n), search: {} }, grants)
const loaded = (model: Model, chain = CHAINS[0]) => {
	expect(chain).toBeDefined()
	return chain === undefined
		? model
		: run(model, [
				Message.CompletedFetchExisting({
					key: model.existing.key ?? "",
					result: Result.succeed(chain),
				}),
			])
}
const editing = (n: number, grants = ENGINEER) => loaded(opening(n, grants), CHAINS[n - 1])

describe("escalation chain editor", () => {
	test("a new chain reads as a sentence from the start card to the end card", () => {
		scene(
			{ update: pageUpdate, view },
			given(newChain()),
			expectView(text("New escalation chain")).toExist(),
			expectView(text("When an alert escalates to this chain")).toExist(),
			expectView(text("Notify")).toExist(),
			// Nothing follows the last step of a chain that does not repeat.
			expectView(text("minutes, then stop")).toExist(),
			expectView(text("If nobody acknowledges, repeat the chain")).toExist(),
			expectView(role("button", { name: "Cancel" })).toExist(),
			expectView(role("button", { name: "Create chain" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(run(newChain(), [Message.ChangedRepeatCount({ value: "2" })])),
			expectView(text("minutes for an acknowledgement, then repeat")).toExist(),
		)
	})

	test("builds a chain: add steps, insert between, reorder, remove, then save back to Routing", () => {
		const first = run(newChain(), [
			Message.ChangedName({ value: "Checkout on-call" }),
			pick("s0", `destination:${chainDestinationUuid(1)}`),
			Message.ClickedInsertStep({ index: 1 }),
			pick("s1", `destination:${chainDestinationUuid(2)}`),
			Message.ChangedWait({ key: "s0", value: "5" }),
		])
		expect(keys(first)).toEqual(["s0", "s1"])
		// The + between the two cards puts a new step in the middle.
		scene(
			{ update: pageUpdate, view },
			given(first),
			expectView(text("Slack #alerts-api")).toExist(),
			expectView(text("minutes for an acknowledgement")).toExist(),
			click(role("button", { name: "Add a step after step 1" })),
			Command.resolve(FocusChainElement, Message.CompletedFocus()),
			expectView(role("button", { name: "Actions for step 3" })).toExist(),
		)
		const middle = pageUpdate(first, Message.ClickedInsertStep({ index: 1 })).model
		expect(keys(middle)).toEqual(["s0", "s2", "s1"])
		const reordered = run(middle, [act("s1", "up"), act("s1", "up"), act("s2", "remove")])
		expect(keys(reordered)).toEqual(["s1", "s0"])
		const saved = pageUpdate(reordered, Message.ClickedSave())
		expect(names(saved.commands)).toEqual(["SaveEscalationChainFromEditor"])
		expect(
			Option.map(payloadOf(reordered.form), (payload) => Arr.map(payload.steps, (s) => s.wait_minutes)),
		).toEqual(Option.some([10, 5]))
		const chain = CHAINS[0]
		expect(chain).toBeDefined()
		if (chain === undefined) return
		const done = pageUpdate(saved.model, Message.CompletedSave({ result: Result.succeed(chain) }))
		expect(done.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: "/alerts/routing",
			toast: { title: "Escalation chain created" },
		})
		// The saved form is not an unsaved edit: leaving does not ask.
		expect(isBlockingNavigation(done.model)).toBe(false)
	})

	test("a step edit moves focus to where the work continues", () => {
		const two = pageUpdate(newChain(), Message.ClickedInsertStep({ index: 1 }))
		// A new step: its Add button, so its targets come next.
		expect(two.commands).toMatchObject([
			{ name: "FocusEscalationChainElement", args: { id: triggerId(menuIdOf("targets", "s1")) } },
		])
		const copied = pageUpdate(two.model, act("s0", "duplicate"))
		expect(Arr.last(copied.commands ?? [])).toMatchObject(
			Option.some({ args: { id: triggerId(menuIdOf("targets", "s2")) } }),
		)
		// A removed step: the step before it, or the + that now leads the chain.
		const removedLast = pageUpdate(two.model, act("s1", "remove"))
		expect(Arr.last(removedLast.commands ?? [])).toMatchObject(
			Option.some({ args: { id: triggerId(menuIdOf("actions", "s0")) } }),
		)
		const removedFirst = pageUpdate(two.model, act("s0", "remove"))
		expect(Arr.last(removedFirst.commands ?? [])).toMatchObject(
			Option.some({ args: { id: insertButtonId(0) } }),
		)
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
		const saving = pageUpdate(
			run(model, [Message.ChangedName({ value: "Checkout" })]),
			Message.ClickedSave(),
		)
		expect(names(saving.commands)).toEqual(["SaveEscalationChainFromEditor"])
		const chain = CHAINS[0]
		expect(chain).toBeDefined()
		if (chain === undefined) return
		// Back to the list, which reads the saved name and rules fresh.
		expect(
			pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(chain) })).outMessage,
		).toMatchObject({ url: "/alerts/routing", toast: { title: "Escalation chain saved" } })
	})

	test("people and schedules read by name, with who is on call and who has left", () => {
		const schedule = populatedSchedules()[0]
		expect(schedule).toBeDefined()
		const chain = mixedTargetChain(chainDestinationUuid(1))
		const model = loaded(opening(1), chain)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text(schedule?.name ?? "")).toExist(),
			expectView(text(/ on call$/u)).toExist(),
			expectView(text(oncallMembers[1]?.name ?? "")).toExist(),
		)
		// Someone removed from the org since the chain was saved.
		scene(
			{ update: pageUpdate, view },
			given({
				...model,
				members: Arr.filter(model.members ?? [], (member) => member.userId !== memberId(0)),
			}),
			expectView(text("Unavailable member")).toExist(),
		)
	})

	test("the target picker says what is still loading, and where to make a destination", () => {
		const menuId = menuIdOf("targets", "s0")
		const open = (model: Model): Model => ({
			...model,
			menus: { [menuId]: Menu.init(menuId, { isOpen: true }) },
		})
		scene(
			{ update: pageUpdate, view },
			given(open({ ...newChain(), destinations: null, schedules: null })),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(text("Loading destinations")).toExist(),
			expectView(text("Loading schedules")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(open({ ...newChain(), destinations: [], members: [], schedules: [] })),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(text(/No destinations yet/u)).toExist(),
			expectView(role("link", { name: "Create a destination" })).toHaveAttr("href", "/alerts/routing"),
		)
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
			expectView(within(role("alertdialog"), role("button", { name: "Delete chain" }))).toBeDisabled(),
		)
	})

	test("a delete the API refuses reads the chain again, so the dialog names the rule that took it", () => {
		const asked = run(editing(2), [Message.ClickedDelete(), Message.ClickedConfirmDelete()])
		expect(asked.isDeleting).toBe(true)
		const refused = pageUpdate(asked, Message.CompletedDelete({ result: Result.fail(IN_USE) }))
		expect(refused.model.deleteError).toMatch(/Remove it from the rule's severity tiers first/u)
		expect(names(refused.commands)).toEqual(["FetchEscalationChainEditorChain"])
		const chain = CHAINS[1]
		expect(chain).toBeDefined()
		if (chain === undefined) return
		const edited = run(refused.model, [Message.ChangedName({ value: "Payments" })])
		const reread = pageUpdate(
			edited,
			Message.CompletedFetchExisting({
				key: edited.existing.key ?? "",
				result: Result.succeed({ ...chain, rule_ids: CHAINS[0]?.rule_ids ?? [] }),
			}),
		).model
		// The re-read brings the rules, never the form: an edit in progress stays.
		expect(reread.form.name).toBe("Payments")
		scene(
			{ update: pageUpdate, view },
			given(reread),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Used by 2 rules")).toExist(),
			expectView(text(/These rules would stop escalating/u)).toExist(),
		)
	})

	test("an unused chain deletes and goes back to Routing", () => {
		const unused = editing(3)
		const confirmed = pageUpdate(
			pageUpdate(unused, Message.ClickedDelete()).model,
			Message.ClickedConfirmDelete(),
		)
		expect(names(confirmed.commands)).toEqual(["DeleteEscalationChainFromEditor"])
		const done = pageUpdate(confirmed.model, Message.CompletedDelete({ result: Result.void }))
		expect(done.outMessage).toMatchObject({ _tag: "RequestedNavigation", url: "/alerts/routing" })
		// Deleted elsewhere first: the same outcome.
		expect(
			pageUpdate(confirmed.model, Message.CompletedDelete({ result: Result.fail(GONE) })).outMessage,
		).toMatchObject({ url: "/alerts/routing", toast: { title: "Escalation chain deleted" } })
	})

	test("Cancel leaves at once with nothing to lose, and asks first over unsaved edits", () => {
		const clean = editing(1)
		expect(isBlockingNavigation(clean)).toBe(false)
		expect(pageUpdate(clean, Message.ClickedCancel()).outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: "/alerts/routing",
		})
		const dirty = run(clean, [Message.ChangedWait({ key: "s0", value: "20" })])
		expect(isBlockingNavigation(dirty)).toBe(true)
		// An edit put back is no edit.
		expect(isBlockingNavigation(run(dirty, [Message.ChangedWait({ key: "s0", value: "10" })]))).toBe(
			false,
		)
		const asked = pageUpdate(dirty, Message.ClickedCancel())
		expect(asked.outMessage).toBeUndefined()
		expect(asked.model.leaveDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(asked.model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Unsaved changes")).toExist(),
			expectView(role("button", { name: "Stay" })).toExist(),
			expectView(role("button", { name: "Discard changes" })).toExist(),
		)
		const discarded = pageUpdate(asked.model, Message.ClickedDiscard())
		expect(discarded.outMessage).toMatchObject({ url: "/alerts/routing" })
		expect(isBlockingNavigation(discarded.model)).toBe(false)
	})

	test("a chain deleted elsewhere reads as not found, with the way back and nothing to retry", () => {
		const opened = opening(1)
		const gone = pageUpdate(
			opened,
			Message.CompletedFetchExisting({ key: opened.existing.key ?? "", result: Result.fail(GONE) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(gone),
			expectView(text("Escalation chain not found")).toExist(),
			expectView(role("link", { name: "Back to routing" })).toHaveAttr("href", "/alerts/routing"),
			expectView(role("button", { name: "Try again" })).not.toExist(),
		)
		// Deleted while it was being edited: the save says so.
		const saving = pageUpdate(editing(1), Message.ClickedSave()).model
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(saving, Message.CompletedSave({ result: Result.fail(GONE) })).model),
			expectView(text(/This chain no longer exists/u)).toExist(),
		)
	})

	test("a viewer who cannot manage alerts reads the chain and its rules, and can change nothing", () => {
		const model = editing(1, MEMBER)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Only org admins and engineers can change escalation chains")).toExist(),
			expectView(text("Slack #alerts-api")).toExist(),
			expectView(text("Used by 2 rules")).toExist(),
			expectView(role("textbox", { name: "Name" })).toBeDisabled(),
			expectView(role("button", { name: "Save chain" })).not.toExist(),
			expectView(role("button", { name: "Delete chain" })).not.toExist(),
			expectView(role("button", { name: "Actions for step 1" })).not.toExist(),
			expectView(role("button", { name: "Add a step after step 1" })).not.toExist(),
			expectView(role("button", { name: "Stop notifying Slack #alerts-api" })).not.toExist(),
			expectView(role("link", { name: "Back to routing" })).toExist(),
		)
		// The update holds the same line as the view.
		expect(run(model, [Message.ChangedName({ value: "Mine now" })]).form.name).toBe("Checkout on-call")
		expect(names(pageUpdate(model, Message.ClickedSave()).commands)).toEqual([])
		expect(pageUpdate(model, Message.ClickedDelete()).model.deleteDialog.isOpen).toBe(false)
		// A new chain has nothing to read: the viewer learns who can make one.
		scene(
			{ update: pageUpdate, view },
			given(newChain(MEMBER)),
			expectView(text("Only org admins and engineers can create escalation chains")).toExist(),
		)
	})

	test("nothing can be saved or changed until the session says who the viewer is", () => {
		const opened = init({ _tag: "AlertsEscalationChainNew", search: {} }, context).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			expectView(role("button", { name: "Create chain" })).not.toExist(),
		)
	})

	test("a link with a malformed chain id says the chain was not found", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered({ _tag: "AlertsEscalationChain", chainId: "nope", search: {} })),
			expectView(text("Escalation chain not found")).toExist(),
		)
	})
})
