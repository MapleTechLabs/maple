import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { CreateDashboard, DeleteDashboard, SavePreferences, SaveTags } from "./command"
import { Message } from "./message"
import type { ListDashboard, Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

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
	[
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.CompletedLoadPreferences({ favorites: [], sort: "updated" }),
		Message.UpdatedDashboards({ orgId, dashboards }),
	].reduce((model, message) => pageUpdate(model, message).model, init({ search }, context).model)

describe("dashboards list", () => {
	test("entry reads the clock and the stored preferences, then renders rows as links", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual([
			"ReadDashboardsListClock",
			"LoadDashboardsPreferences",
		])
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
		const model = routeChanged(loaded(), { _tag: "Dashboards", search: { q: "zzz" } }).model
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
		expect(names(pageUpdate(model, Message.ClickedConfirmDelete()).commands)).toContain(
			DeleteDashboard.name,
		)
		const failed = pageUpdate(
			model,
			Message.CompletedDeleteDashboard({
				result: Result.fail("Dashboard persistence is temporarily unavailable"),
			}),
		).model
		expect(failed.persistenceError).toBe("Dashboard persistence is temporarily unavailable")
		expect(names(pageUpdate(failed, Message.ClickedCreate()).commands)).toEqual([])
	})

	test("the tag editor commits typed tags normalised and saves them", () => {
		const editing = { ...loaded(), pendingTags: dashboard() }
		const typed = pageUpdate(editing, Message.ChangedTagInput({ value: "SLO, api" })).model
		const committed = pageUpdate(typed, Message.PressedTagInputKey({ key: "Enter" })).model
		expect(committed.tagDrafts).toEqual(["api", "slo"])
		const saved = pageUpdate(committed, Message.ClickedSaveTags())
		expect(names(saved.commands)).toContain(SaveTags.name)
		expect(saved.model.pendingTags).toBeNull()
	})
})
