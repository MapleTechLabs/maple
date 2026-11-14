import { OrgId } from "@maple/domain"
import { V2Investigation } from "@maple/domain/http/v2"
import { Array as Arr, Result, Schema } from "effect"
import {
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	scene,
	selector,
	Subscription,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { MeasureTabIndicator, Message as TabsMessage } from "@maple/views/ui/tabs"
import { VERDICT_LAB_CASES } from "../../../lab/verdict-fixture"
import { type PageContext, PageOutMessage } from "../../contract"
import { MountInvestigationRows } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, ScrollFocusedRow, update } from "./update"
import { view as pageView } from "./view"

// J / K / arrows step through the rows on screen, Enter opens the focused one, Escape lets go.

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const base = Arr.getUnsafe(VERDICT_LAB_CASES, 0).investigation
const decodeId = Schema.decodeSync(V2Investigation.fields.id)

/** A diagnosed (Active) investigation; a later `minute` sorts it higher. */
const investigation = (n: number, title: string, minute: number): V2Investigation => ({
	...base,
	id: decodeId(`${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`),
	snapshot: { ...base.snapshot, title },
	updated_at: `2026-09-18T09:${minute}:00.000Z`,
})

const newest = investigation(4, "Checkout latency regression", 30)
const older = investigation(5, "Search index lag", 20)
const oldest = investigation(6, "Export job retries", 10)

const loaded = (): Model => {
	const entered = init({ search: {} }, context).model
	return pageUpdate(
		entered,
		Message.CompletedFetchFirstPage({
			key: entered.firstPage.key ?? "",
			result: Result.succeed({ data: [oldest, newest, older], hasMore: false, nextCursor: null }),
		}),
	).model
}

const measured = () =>
	Mount.resolve(
		MeasureTabIndicator,
		TabsMessage.MeasuredIndicator({
			rect: { left: 2, right: 115, top: 2, bottom: 2, width: 51, height: 28 },
		}),
	)
const rowsMounted = () => Mount.resolve(MountInvestigationRows, Message.ClickedRow({ id: newest.id }))
const press = (key: string) => Subscription.emit(Message.PressedListKey({ key }))
const scrolled = () => Command.resolve(ScrollFocusedRow, Message.CompletedScrollFocusedRow())
const focusedRow = selector("[data-focused]")

describe("investigations list keys", () => {
	test("J and K move the focus through the rows in their sorted order, and Escape clears it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			measured(),
			rowsMounted(),
			expectView(focusedRow).toBeAbsent(),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("Checkout latency regression"),
			press("ArrowDown"),
			scrolled(),
			expectView(focusedRow).toContainText("Search index lag"),
			press("j"),
			scrolled(),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("Export job retries"),
			press("k"),
			scrolled(),
			expectView(focusedRow).toContainText("Search index lag"),
			press("Escape"),
			expectView(focusedRow).toBeAbsent(),
		)
	})

	test("Enter opens the focused investigation as a click on its row does", () => {
		const focused = Arr.reduce(
			["j", "j"],
			loaded(),
			(model, key) => pageUpdate(model, Message.PressedListKey({ key })).model,
		)
		const entered = pageUpdate(focused, Message.PressedListKey({ key: "Enter" }))
		expect(entered.outMessage).toEqual(
			pageUpdate(focused, Message.ClickedRow({ id: older.id })).outMessage,
		)
		scene(
			{ update: pageUpdate, view },
			given(focused),
			measured(),
			rowsMounted(),
			press("Enter"),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: `/investigations/${older.id}`, isReplace: false }),
			),
		)
	})

	test("Enter with no focused row opens nothing", () => {
		expect(pageUpdate(loaded(), Message.PressedListKey({ key: "Enter" })).outMessage).toBeUndefined()
	})

	test("a new view, search or sort starts the focus over", () => {
		const focused = pageUpdate(loaded(), Message.PressedListKey({ key: "j" })).model
		expect(focused.focusedIndex).toBe(0)
		expect(routeChanged(focused, { search: { q: "search" } }, context).model.focusedIndex).toBeNull()
		expect(routeChanged(focused, { search: { view: "history" } }, context).model.focusedIndex).toBeNull()
		expect(routeChanged(focused, { search: { dir: "asc" } }, context).model.focusedIndex).toBeNull()
	})
})
