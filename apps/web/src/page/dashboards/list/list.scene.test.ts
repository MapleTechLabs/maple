import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import {
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	role,
	scene,
	selector,
	Subscription,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { CreateDashboard, DeleteDashboard, SavePreferences, SaveTags } from "./command"
import * as TagEditor from "../kit/tag-editor"
import * as Combobox from "@maple/views/ui/combobox"
import { Message } from "./message"
import type { ListDashboard, Model } from "./model"
import { init, routeChanged, ScrollFocusedRow, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const dashboard = (overrides: Partial<ListDashboard> = {}): ListDashboard => ({
	id: "dash_platform",
	name: "Platform overview",
	description: "Cross-service health.",
	tags: [],
	widgetCount: 8,
	readsShort: "Traces · Errors",
	readsFull: "Traces · Errors",
	glyph: "PulseIcon",
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	...overrides,
})

const BOARDS = [
	dashboard(),
	dashboard({ id: "dash_payment", name: "Payment service health", updatedAt: "2026-10-01T11:00:00.000Z" }),
	dashboard({
		id: "dash_empty",
		name: "Checkout health",
		widgetCount: 0,
		readsShort: "—",
		glyph: "GridIcon",
	}),
]

/** Entered with its clock, preferences and rows. */
const loaded = (search = {}, dashboards: ReadonlyArray<ListDashboard> = BOARDS): Model =>
	Arr.reduce(
		[
			Message.CompletedReadClock({ nowMs: NOW, locale: "en-US" }),
			Message.CompletedLoadPreferences({ favorites: [], sort: "updated" }),
			Message.UpdatedDashboards({ orgId, dashboards }),
		],
		init({ search }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

describe("dashboards list", () => {
	test("entry reads the clock and the stored preferences, then renders rows as links", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining(["ReadDashboardsListClock", "LoadDashboardsPreferences"]),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("link", { name: /Platform overview/ })).toHaveAttr(
				"href",
				"/dashboards/dash_platform",
			),
			expectView(text("3 dashboards · 16 widgets · last edited 1h ago · 1 with no widgets")).toExist(),
		)
	})

	test("the header formats its counts and dates in the locale read with the clock", () => {
		const many = Array.from({ length: 1200 }, (_, index) =>
			dashboard({ id: `dash_${index}`, widgetCount: 1, updatedAt: "2026-09-01T12:00:00.000Z" }),
		)
		const model = Arr.reduce(
			[
				Message.CompletedReadClock({ nowMs: NOW, locale: "de-DE" }),
				Message.CompletedLoadPreferences({ favorites: [], sort: "updated" }),
				Message.UpdatedDashboards({ orgId, dashboards: many }),
			],
			init({ search: {} }, context).model,
			(next, message) => pageUpdate(next, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("1.200 dashboards · 1.200 widgets · last edited 1. Sept. 2026")).toExist(),
		)
	})

	test("rows for another org are dropped", () => {
		const model = loaded()
		const other = Schema.decodeSync(OrgId)("org_other")
		const next = pageUpdate(model, Message.UpdatedDashboards({ orgId: other, dashboards: [] })).model
		expect(next.dashboards).toEqual(BOARDS)
	})

	test("an empty org shows the first-run state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({}, [])),
			expectView(text("No dashboards yet")).toExist(),
			expectView(role("button", { name: "Create blank dashboard" })).toExist(),
		)
	})

	test("search debounces into ?q and a stale debounce is dropped", () => {
		const typed = pageUpdate(loaded(), Message.ChangedSearchDraft({ value: " pay " }))
		expect(names(typed.commands)).toEqual(["WaitDashboardsSearchDebounce"])
		expect(
			pageUpdate(typed.model, Message.ElapsedSearchDebounce({ generation: 0 })).outMessage,
		).toBeUndefined()
		expect(
			pageUpdate(
				typed.model,
				Message.ElapsedSearchDebounce({ generation: typed.model.searchGeneration }),
			).outMessage,
		).toEqual(PageOutMessage.RequestedNavigation({ url: "/dashboards?q=pay", isReplace: true }))
	})

	test("a search that matches nothing offers to clear it", () => {
		const model = routeChanged(loaded(), { search: { q: "zzz" } }).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("No dashboard matches “zzz”")).toExist(),
			expectView(role("button", { name: "Clear search" })).toExist(),
		)
	})

	test("starring writes the favorites and moves the row into Favorites", () => {
		const starred = pageUpdate(loaded(), Message.ToggledFavorite({ id: "dash_platform" }))
		expect(names(starred.commands)).toEqual([SavePreferences.name])
		scene(
			{ update: pageUpdate, view },
			given(starred.model),
			expectView(text("Favorites")).toExist(),
			expectView(role("button", { name: "Unstar Platform overview" })).toHaveAttr(
				"aria-pressed",
				"true",
			),
		)
	})

	test("Create is guarded while one is in flight and opens the new board in edit mode", () => {
		const creating = pageUpdate(loaded(), Message.ClickedCreate())
		expect(names(creating.commands)).toEqual([CreateDashboard.name])
		expect(names(pageUpdate(creating.model, Message.ClickedCreate()).commands)).toEqual([])
		expect(
			pageUpdate(
				creating.model,
				Message.CompletedCreateDashboard({ result: Result.succeed("dash_new") }),
			).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/dashboards/dash_new?mode=edit", isReplace: false }),
		)
	})

	test("confirming a delete sends it; a failed write turns the list read-only", () => {
		const model = { ...loaded(), pendingDelete: dashboard() }
		const confirmed = pageUpdate(model, Message.ClickedConfirmDelete())
		expect(names(confirmed.commands)).toContain(DeleteDashboard.name)
		expect(confirmed.model.isDeleting).toBe(true)
		expect(names(pageUpdate(confirmed.model, Message.ClickedConfirmDelete()).commands)).toEqual([])
		const failed = pageUpdate(
			confirmed.model,
			Message.CompletedDeleteDashboard({
				result: Result.fail({
					message: "Dashboard persistence is temporarily unavailable",
					isRejected: false,
				}),
			}),
		).model
		expect(failed.persistenceError).toBe("Dashboard persistence is temporarily unavailable")
		expect(failed.isDeleting).toBe(false)
		expect(names(pageUpdate(failed, Message.ClickedCreate()).commands)).toEqual([])
	})

	test("the read-only banner names a rejected write's reason, and an unreachable API as such", () => {
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(), persistenceError: "A dashboard with this name already exists" }),
			expectView(
				text(/A dashboard with this name already exists\. Editing, import and delete/),
			).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(), persistenceError: "Failed to fetch" }),
			expectView(text(/Couldn't reach Maple, so editing/)).toExist(),
		)
	})

	test("the tag editor commits typed tags normalised and saves them", () => {
		const editing = { ...loaded(), pendingTags: dashboard() }
		const tagKey = (message: TagEditor.Message) => Message.GotTagEditorMessage({ message })
		const typed = pageUpdate(
			editing,
			tagKey(TagEditor.Message.ChangedTagInput({ value: "SLO, api" })),
		).model
		const committed = pageUpdate(
			typed,
			tagKey(TagEditor.Message.PressedTagInputKey({ key: "Enter" })),
		).model
		expect(committed.tagEditor.drafts).toEqual(["api", "slo"])
		const saved = pageUpdate(committed, tagKey(TagEditor.Message.ClickedSaveTags()))
		expect(names(saved.commands)).toContain(SaveTags.name)
		expect(saved.model.pendingTags).toBeNull()
	})

	test("a picked tag filters through the URL; Clear tags drops the filter", () => {
		const tag = (message: Combobox.Message) => Message.GotTagFilterMessage({ message })
		const opened = pageUpdate(loaded(), tag(Combobox.Message.ClickedTriggerOf({ items: ["slo"] }))).model
		const picked = pageUpdate(opened, tag(Combobox.Message.ClickedItem({ value: "slo" })))
		const url = picked.outMessage?._tag === "RequestedNavigation" ? picked.outMessage.url : ""
		expect(decodeURIComponent(url)).toContain("tags")
		expect(decodeURIComponent(url)).toContain("slo")
		const cleared = pageUpdate(picked.model, tag(Combobox.Message.ClearedSelection()))
		expect(cleared.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/dashboards", isReplace: true }),
		)
	})
})

describe("dashboards list keys", () => {
	const press = (key: string) => Subscription.emit(Message.PressedListKey({ key }))
	const scrolled = () => Command.resolve(ScrollFocusedRow, Message.CompletedScrollFocusedRow())
	const focusedRow = selector("[data-focused]")
	// Newest edit first: Payment, Platform, Checkout.
	const boards = [
		dashboard({ updatedAt: "2026-09-29T12:00:00.000Z" }),
		dashboard({
			id: "dash_payment",
			name: "Payment service health",
			updatedAt: "2026-10-01T11:00:00.000Z",
		}),
		dashboard({ id: "dash_checkout", name: "Checkout health", updatedAt: "2026-09-20T12:00:00.000Z" }),
	]
	const pressed = (model: Model, ...keys: ReadonlyArray<string>): Model =>
		Arr.reduce(keys, model, (next, key) => pageUpdate(next, Message.PressedListKey({ key })).model)

	test("J and K move the focus through the rows in their sorted order, and Escape clears it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({}, boards)),
			expectView(focusedRow).toBeAbsent(),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("Payment service health"),
			press("ArrowDown"),
			scrolled(),
			expectView(focusedRow).toContainText("Platform overview"),
			press("j"),
			scrolled(),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("Checkout health"),
			press("k"),
			scrolled(),
			expectView(focusedRow).toContainText("Platform overview"),
			press("Escape"),
			expectView(focusedRow).toBeAbsent(),
		)
	})

	test("Enter follows the focused row's link", () => {
		scene(
			{ update: pageUpdate, view },
			given(pressed(loaded({}, boards), "j", "j")),
			expectView(role("link", { name: /Platform overview/ })).toHaveAttr(
				"href",
				"/dashboards/dash_platform",
			),
			press("Enter"),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/dashboards/dash_platform", isReplace: false }),
			),
		)
	})

	test("starred rows come first, and the focus stays on its dashboard when a star moves it", () => {
		const focused = pressed(loaded({}, boards), "j", "j", "j")
		const starred = pageUpdate(focused, Message.ToggledFavorite({ id: "dash_checkout" })).model
		scene(
			{ update: pageUpdate, view },
			given(starred),
			expectView(focusedRow).toContainText("Checkout health"),
			press("k"),
			scrolled(),
			// Already the first row: the starred section leads the list.
			expectView(focusedRow).toContainText("Checkout health"),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("Payment service health"),
		)
	})

	test("a new search or sort starts the focus over", () => {
		const focused = pressed(loaded({}, boards), "j")
		expect(focused.focusedId).toBe("dash_payment")
		expect(routeChanged(focused, { search: { q: "health" } }).model.focusedId).toBeNull()
		expect(routeChanged(focused, { search: { sort: "name" } }).model.focusedId).toBeNull()
	})
})
