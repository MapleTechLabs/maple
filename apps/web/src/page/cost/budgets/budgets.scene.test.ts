import { OrgId } from "@maple/domain"
import {
	CloudCostPersistenceError,
	type CostBudgetListResponse,
	type CostBudgetStatus,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import { MountNetworkAutoRetry } from "@maple/views/ui/error-state"
import { Array as Arr, Option, Result, Schema } from "effect"
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
import { budgetsOf, noBudgets } from "../../../lab/cost-budgets-fixture"
import { LAB_SOURCES, LAB_VERCEL_TEAM } from "../../../lab/cost-fixture"
import { type PageContext, PageOutMessage } from "../../contract"
import { budgetFormHref } from "../kit/budget-format"
import { DeleteBudget, FetchBudgets, SaveBudgetEnabled } from "./command"
import { budgetById, budgetsOf as shown } from "./derive"
import { Message, type Model } from "./model"
import { enter, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
/** Mid November: fifteen complete days of the month have passed. */
const NOW = Date.UTC(2026, 10, 16, 10, 0)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const LIST = "FetchCostBudgets"

/** The hosted product: the session, not the build, says who may change a budget. */
const init = () => enter(context, true)
const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])
const table = role("table", { name: "Budgets" })

const fold = (model: Model, messages: ReadonlyArray<(model: Model) => Message>): Model =>
	Arr.reduce(messages, model, (current, toMessage) => pageUpdate(current, toMessage(current)).model)

const grantsRead = (grants: ReadonlyArray<Policy.Permission>) => () =>
	Message.CompletedReadGrants({ orgId: context.orgId, grants: [...grants] })

const listed = (list: CostBudgetListResponse) => (model: Model) =>
	Message.CompletedFetchBudgets({ key: model.list.key ?? "", result: Result.succeed(list) })

const LIST_OF_FIVE = budgetsOf(NOW)

/** The page once the list answered, as someone with `grants` sees it. */
const loaded = (
	list: CostBudgetListResponse = LIST_OF_FIVE,
	grants: ReadonlyArray<Policy.Permission> = ENGINEER,
): Model => fold(init().model, [grantsRead(grants), listed(list)])

/** The fixture's budget called `name`. */
const named = (name: string): CostBudgetStatus =>
	Option.getOrThrow(Arr.findFirst(LIST_OF_FIVE.budgets, (budget) => budget.name === name))

const only = (name: string): Model => loaded({ budgets: [named(name)] })

const down = toLoadFailure(new CloudCostPersistenceError({ message: "Cost could not be read" }))

describe("cost budgets", () => {
	// Every member may read budgets, so the list does not wait for the session.
	test("the list is asked for on entry, whoever is looking", () => {
		expect(names(init().commands)).toContain(LIST)
		expect(names(enter(context, false).commands)).toContain(LIST)
	})

	test("a budget under its amount shows what is spent of it, its forecast, and that it is on track", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("All cloud spend")),
			expectView(within(table, text("Monthly · All spend"))).toExist(),
			expectView(within(table, text("$4,180.42 of $12,000.00"))).toExist(),
			expectView(within(table, text("34%"))).toExist(),
			expectView(within(table, text("$8,360.84 by Nov 30"))).toExist(),
			expectView(within(table, text("Warning at 100% forecast"))).toExist(),
			expectView(within(table, text("Critical at 100% spend"))).toExist(),
			expectView(within(table, text("On track"))).toExist(),
		)
	})

	test("a budget whose forecast passes its amount stands at warning before the money is spent", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("AWS production")),
			expectView(
				within(table, text("Monthly · Provider: AWS · Connected account: AWS 123456789012")),
			).toExist(),
			expectView(within(table, text("$3,912.07 of $6,000.00"))).toExist(),
			expectView(within(table, text("$7,824.14 by Nov 30"))).toExist(),
			expectView(within(table, text("Warning"))).toExist(),
			expectView(within(table, text("On track"))).toBeAbsent(),
		)
	})

	test("a budget that is spent stands at critical", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Model spend")),
			expectView(within(table, text("$1,734.90 of $1,500.00"))).toExist(),
			expectView(within(table, text("115%"))).toExist(),
			expectView(within(table, text("Critical"))).toExist(),
		)
	})

	test("a budget in another currency and period reads in its own", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Edge and CDN, EU")),
			expectView(
				within(table, text(/^Quarterly · Provider: Cloudflare · Region: eu-central-1/u)),
			).toExist(),
			expectView(within(table, text("€211.30 of €900.00"))).toExist(),
			expectView(within(table, text(/by Dec 31$/u))).toExist(),
		)
	})

	// Such a budget opens incidents nobody is told about.
	test("a budget whose alerts notify no one says so", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Edge and CDN, EU")),
			expectView(within(table, text("Notifies no one"))).toExist(),
		)
	})

	// Off is off, whatever was spent: a disabled budget is not checked and opens nothing.
	test("a budget that is switched off reads Off, not the severity its spend would have", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Data warehouse")),
			expectView(within(table, text("Off"))).toExist(),
			expectView(within(table, text("Critical"))).toBeAbsent(),
			expectView(role("switch", { name: "Turn on Data warehouse" })).toHaveAttr(
				"aria-checked",
				"false",
			),
		)
	})

	test("whoever manages alerts gets the editor, the switch and delete", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("link", { name: "New budget" })).toHaveAttr("href", budgetFormHref()),
			expectView(role("link", { name: "AWS production" })).toHaveAttr(
				"href",
				budgetFormHref({ budgetId: named("AWS production").id }),
			),
			expectView(role("switch", { name: "Turn off AWS production" })).toExist(),
			expectView(role("button", { name: "Delete AWS production" })).toExist(),
		)
	})

	// A member reads every budget and is offered no write the API would refuse.
	test("a member sees the budgets and nothing to change them with", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(LIST_OF_FIVE, MEMBER)),
			expectView(within(table, text("AWS production"))).toExist(),
			expectView(role("link", { name: "New budget" })).toBeAbsent(),
			expectView(role("link", { name: "AWS production" })).toBeAbsent(),
			expectView(role("switch", { name: "Turn off AWS production" })).toBeAbsent(),
			expectView(role("button", { name: "Delete AWS production" })).toBeAbsent(),
		)
	})

	test("with no budget yet, a manager is offered the first one and a member is told who can make it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(noBudgets)),
			expectView(text("No budgets yet")).toExist(),
			expectView(role("link", { name: "New budget" })).toHaveAttr("href", budgetFormHref()),
			expectView(table).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(noBudgets, MEMBER)),
			expectView(text("No budgets yet")).toExist(),
			expectView(role("link", { name: "New budget" })).toBeAbsent(),
			expectView(text("Org admins and engineers can create budgets")).toExist(),
		)
	})

	test("a list that could not be read says so, and Try again asks for it again", () => {
		const failed = fold(init().model, [
			grantsRead(ENGINEER),
			(model) =>
				Message.CompletedFetchBudgets({ key: model.list.key ?? "", result: Result.fail(down) }),
		])

		const key = failed.list.key ?? ""
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load budgets")).toExist(),
			expectView(table).toBeAbsent(),
			Mount.resolve(
				MountNetworkAutoRetry({ retryKey: JSON.stringify(Message.ClickedRetry()) }),
				Message.ClickedRetry(),
			),
			Command.resolve(
				FetchBudgets({ key }),
				Message.CompletedFetchBudgets({ key, result: Result.succeed(LIST_OF_FIVE) }),
			),
			Mount.expectEnded(MountNetworkAutoRetry),
			expectView(table).toExist(),
		)
	})

	// The save answers with the stored budget and no standing. Another manager may have changed
	// the budget since the list was read, so the switch shows the answer and the list is read again.
	test("the switch shows what the API stored at once, then reads again where the budgets stand", () => {
		const { progress, ...budget } = named("AWS production")
		const raised = { ...budget, enabled: false, amount: 8_000 }
		// The re-read is asked for under its own key, so no earlier read can answer for it.
		const key =
			fold(loaded(), [
				() => Message.ToggledBudget({ id: budget.id }),
				() => Message.CompletedToggle({ id: budget.id, result: Result.succeed(raised) }),
			]).list.key ?? ""
		const reread = {
			budgets: Arr.map(LIST_OF_FIVE.budgets, (row) =>
				row.id === budget.id ? { ...raised, progress: { ...progress, percent: 48.9 } } : row,
			),
		}

		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			click(role("switch", { name: "Turn off AWS production" })),
			Command.resolve(
				SaveBudgetEnabled({ id: budget.id, enabled: false }),
				Message.CompletedToggle({ id: budget.id, result: Result.succeed(raised) }),
			),
			expectView(role("switch", { name: "Turn on AWS production" })).toHaveAttr(
				"aria-checked",
				"false",
			),
			expectView(within(table, text("$3,912.07 of $8,000.00"))).toExist(),
			expectView(within(table, text("65%"))).toExist(),
			Command.resolve(
				FetchBudgets({ key }),
				Message.CompletedFetchBudgets({ key, result: Result.succeed(reread) }),
			),
			expectView(within(table, text("48%"))).toExist(),
			expectView(within(table, text("65%"))).toBeAbsent(),
		)
	})

	// Two switches in quick succession: the first one's re-read was sent before the second write,
	// so it still has the second budget on. Landing last, it must not flip that switch back.
	test("a re-read sent before a later write does not undo that write when it lands last", () => {
		const stored = (name: string) => {
			const { progress: _, ...budget } = named(name)
			return { ...budget, enabled: false }
		}
		const [first, second] = [stored("AWS production"), stored("Model spend")]
		const toggled = (model: Model, budget: typeof first): Model =>
			fold(model, [
				() => Message.ToggledBudget({ id: budget.id }),
				() => Message.CompletedToggle({ id: budget.id, result: Result.succeed(budget) }),
			])
		const afterFirst = toggled(loaded(), first)
		const afterSecond = toggled(afterFirst, second)
		const listWith = (off: ReadonlyArray<string>) => ({
			budgets: Arr.map(LIST_OF_FIVE.budgets, (row) =>
				Arr.contains(off, row.id) ? { ...row, enabled: false } : row,
			),
		})
		const answered = (model: Model, key: string | null, off: ReadonlyArray<string>) =>
			pageUpdate(
				model,
				Message.CompletedFetchBudgets({ key: key ?? "", result: Result.succeed(listWith(off)) }),
			).model
		const isOn = (model: Model, id: typeof second.id) =>
			Option.map(budgetById(model, id), (budget) => budget.enabled)

		expect(afterSecond.list.key).not.toBe(afterFirst.list.key)
		const late = answered(afterSecond, afterFirst.list.key, [first.id])
		expect(isOn(late, second.id)).toEqual(Option.some(false))
		const settled = answered(late, afterSecond.list.key, [first.id, second.id])
		expect(isOn(settled, first.id)).toEqual(Option.some(false))
		expect(isOn(settled, second.id)).toEqual(Option.some(false))
		// The other order: the newer read answers first, and the older one cannot overwrite it.
		const newerFirst = answered(afterSecond, afterSecond.list.key, [first.id, second.id])
		const overtaken = answered(newerFirst, afterFirst.list.key, [first.id])
		expect(isOn(overtaken, second.id)).toEqual(Option.some(false))
		expect(overtaken.list).toBe(newerFirst.list)
	})

	// An account's id means nothing to a reader: the org's sources say what reads it.
	test("an account a budget covers reads by its provider and name once the sources answer", () => {
		const budget = { ...named("All cloud spend"), filters: { account: [LAB_VERCEL_TEAM.id] } }
		const model = loaded({ budgets: [budget] })
		const sources = [...LAB_SOURCES.synced.sources]
		const answered = (orgId: string) =>
			pageUpdate(model, Message.CompletedFetchSources({ orgId, sources })).model

		expect(names(init().commands)).toContain("FetchCostBudgetSources")
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(within(table, text(`Monthly · Connected account: ${LAB_VERCEL_TEAM.id}`))).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(answered(context.orgId)),
			expectView(
				within(table, text(`Monthly · Connected account: Vercel ${LAB_VERCEL_TEAM.slug}`)),
			).toExist(),
		)
		// An answer for the org the viewer has since left names nothing here.
		expect(answered("org_other").sources).toEqual([])
	})

	// Rounded up, 99.6% would read as reached beside a budget that is still on track.
	test("a budget just under its amount does not read as 100%", () => {
		const budget = named("All cloud spend")
		const nearly = { ...budget, progress: { ...budget.progress, spent: 11_952, percent: 99.6 } }

		scene(
			{ update: pageUpdate, view },
			given(loaded({ budgets: [nearly] })),
			expectView(within(table, text("99%"))).toExist(),
			expectView(within(table, text("100%"))).toBeAbsent(),
			expectView(within(table, text("On track"))).toExist(),
		)
	})

	// No optimistic flip: until the API answers the switch is where it was, and cannot be pressed again.
	test("a toggle in flight leaves the switch as it was, and a second press sends nothing", () => {
		const budget = named("AWS production")
		const pressed = pageUpdate(loaded(), Message.ToggledBudget({ id: budget.id }))

		expect(names(pressed.commands)).toContain("SaveCostBudgetEnabled")
		expect(names(pageUpdate(pressed.model, Message.ToggledBudget({ id: budget.id })).commands)).toEqual(
			[],
		)
		expect(budgetById(pressed.model, budget.id)).toEqual(Option.some(budget))
		// Leaving for the editor would drop the save's answer, so Edit waits with the switch.
		scene(
			{ update: pageUpdate, view },
			given(pressed.model),
			expectView(role("button", { name: "Edit AWS production" })).toBeDisabled(),
			expectView(role("button", { name: "Edit Model spend" })).toBeEnabled(),
		)
	})

	test("a toggle the API refuses leaves the budget as it was and says why", () => {
		const budget = named("AWS production")
		const pressed = pageUpdate(loaded(), Message.ToggledBudget({ id: budget.id })).model
		const failed = pageUpdate(
			pressed,
			Message.CompletedToggle({ id: budget.id, result: Result.fail(down) }),
		)

		expect(failed.outMessage).toMatchObject({ type: "error", title: "Couldn't update the budget" })
		expect(budgetById(failed.model, budget.id)).toEqual(Option.some(budget))
	})

	test("delete asks first, and says the budget's incidents go with it", () => {
		const budget = named("Model spend")
		const asked = pageUpdate(loaded(), Message.ClickedDelete({ id: budget.id }))

		expect(names(asked.commands)).not.toContain(DeleteBudget.name)
		scene(
			{ update: pageUpdate, view },
			given(asked.model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(within(role("alertdialog"), text("Delete Model spend?"))).toExist(),
			expectView(
				within(role("alertdialog"), text(/the incidents it opened are deleted with it/u)),
			).toExist(),
			expectView(within(role("alertdialog"), role("button", { name: "Delete budget" }))).toExist(),
		)
	})

	test("a confirmed delete removes the budget once the API says it is gone", () => {
		const budget = named("Model spend")
		const asked = pageUpdate(loaded(), Message.ClickedDelete({ id: budget.id })).model
		const confirmed = pageUpdate(asked, Message.ClickedConfirmDelete())

		expect(confirmed.commands?.[0]).toMatchObject({ name: DeleteBudget.name, args: { id: budget.id } })
		// Still listed while the request is out.
		expect(shown(confirmed.model)).toHaveLength(LIST_OF_FIVE.budgets.length)

		const deleted = pageUpdate(
			confirmed.model,
			Message.CompletedDelete({ id: budget.id, result: Result.succeed({ id: budget.id }) }),
		)
		expect(deleted.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Budget deleted", description: "" }),
		)
		expect(deleted.model.deleteDialog.isOpen).toBe(false)
		expect(budgetById(deleted.model, budget.id)).toEqual(Option.none())
	})

	test("a delete the API refuses keeps the budget and its dialog, and says why", () => {
		const budget = named("Model spend")
		const asked = pageUpdate(loaded(), Message.ClickedDelete({ id: budget.id })).model
		const confirmed = pageUpdate(asked, Message.ClickedConfirmDelete()).model
		const failed = pageUpdate(
			confirmed,
			Message.CompletedDelete({ id: budget.id, result: Result.fail(down) }),
		)

		expect(failed.outMessage).toMatchObject({ type: "error", title: "Couldn't delete the budget" })
		expect(budgetById(failed.model, budget.id)).toEqual(Option.some(budget))
		expect(failed.model.deletingId).toBeNull()
	})
})
