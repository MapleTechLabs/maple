import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { MeasureTabIndicator, Message as TabsMessage } from "../../../ui/tabs"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message } from "./message"
import type { Model, TriageBudget } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_parity"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const measured = () =>
	Mount.resolve(
		MeasureTabIndicator,
		TabsMessage.MeasuredIndicator({
			rect: { left: 2, right: 115, top: 2, bottom: 2, width: 51, height: 28 },
		}),
	)

const settle = (model: Model, data: ReadonlyArray<never>) =>
	pageUpdate(
		model,
		Message.CompletedFetchFirstPage({
			key: model.firstPage.key ?? "",
			result: Result.succeed({ data, hasMore: false, nextCursor: null }),
		}),
	).model

describe("investigations list", () => {
	test("entry reads the clock, the first page and the triage budget", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining([
				"LoadInvestigationsPresence",
				"ReadInvestigationsClock",
				"FetchInvestigations",
				"FetchTriageBudget",
			]),
		)
	})

	test("a failed page renders the error state", () => {
		const entered = init({ search: {} }, context).model
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchFirstPage({
				key: entered.firstPage.key ?? "",
				result: Result.fail(toLoadFailure(new Error("down"))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			measured(),
			expectView(text("Investigations could not be loaded")).toExist(),
		)
	})

	test("an empty workspace is the first-run hero; absent traces add the setup prompt", () => {
		const model = settle(init({ search: {} }, context).model, [])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Ask, and Maple goes and finds out.")).toExist(),
			expectView(text("Investigations read your telemetry. Send traces first.")).not.toExist(),
		)
		const absent = pageUpdate(
			model,
			Message.CompletedLoadSignalPresence({
				result: Result.succeed({ traces: { status: "absent", lastSeenMs: null } }),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(absent),
			expectView(text("Investigations read your telemetry. Send traces first.")).toExist(),
		)
	})

	test("the investigate bar creates once and navigates to the new investigation", () => {
		const typed = pageUpdate(
			init({ search: {} }, context).model,
			Message.ChangedSubject({ value: " Why is checkout slow? " }),
		).model
		const started = pageUpdate(typed, Message.SubmittedSubject())
		expect(names(started.commands)).toEqual(["CreateInvestigationQuestion"])
		expect(started.model.subject).toBe("")
		expect(
			pageUpdate(started.model, Message.ClickedSuggestion({ title: "again" })).commands ?? [],
		).toHaveLength(0)
		const done = pageUpdate(started.model, Message.CompletedCreate({ result: Result.succeed("inv-1") }))
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/investigations/inv-1", isReplace: false }),
		)
	})

	test("the budget notice offers Raise the limit to org admins only", () => {
		const entered = init({ search: {} }, context).model
		const budget: TriageBudget = {
			enabled: true,
			ordinaryPaused: true,
			priorityPaused: false,
			pausedDimension: "runs",
			resumesAt: null,
		}
		const paused = pageUpdate(
			entered,
			Message.CompletedFetchBudget({ key: entered.budget.key ?? "", result: Result.succeed(budget) }),
		).model
		const member = { ...paused, isOrgAdmin: false }
		scene(
			{ update: pageUpdate, view },
			given(member),
			measured(),
			expectView(text("Raise the limit")).not.toExist(),
		)
		const admin = pageUpdate(
			member,
			Message.CompletedReadIsAdmin({ orgId: context.orgId, isAdmin: true }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(admin),
			measured(),
			expectView(text("Raise the limit")).toExist(),
		)
		const otherOrg = pageUpdate(
			member,
			Message.CompletedReadIsAdmin({ orgId: "org_other", isAdmin: true }),
		).model
		expect(otherOrg.isOrgAdmin).toBe(false)
	})

	test("search is debounced into the URL", () => {
		const typed = pageUpdate(
			init({ search: {} }, context).model,
			Message.ChangedSearchDraft({ value: "pool" }),
		)
		expect(names(typed.commands)).toEqual(["WaitInvestigationsSearch"])
		expect(
			pageUpdate(typed.model, Message.ElapsedSearchDebounce({ generation: 0 })).outMessage,
		).toBeUndefined()
		expect(pageUpdate(typed.model, Message.ElapsedSearchDebounce({ generation: 1 })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/investigations?q=pool", isReplace: false }),
		)
	})
})
