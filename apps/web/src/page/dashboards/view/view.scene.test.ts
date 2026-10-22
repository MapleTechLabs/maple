import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	AddWidget,
	FetchShares,
	FetchWidget,
	RemoveWidget,
	RenameDashboard,
	SaveRefreshInterval,
	SaveTags,
	SaveTimeRange,
	UpdateWidgetLayouts,
} from "./command"
import * as TagEditor from "../kit/tag-editor"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const stat = (id: string, field: string) => ({
	id,
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint: "errors_summary",
		transform: { reduceToValue: { field, aggregate: "first" } },
	},
	display: { title: id, unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 2 },
})

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_platform",
	name: "Platform overview",
	timeRange: { type: "relative", value: "6h" },
	widgets: [stat("total-errors", "totalErrors"), stat("error-rate", "errorRate")],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const ROUTE = { dashboardId: "dash_platform", search: {} }

/** Entered, clocked and holding the document. */
const ready = (): Model =>
	[
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	].reduce((model, message) => pageUpdate(model, message).model, init(ROUTE, context).model)

describe("dashboard view", () => {
	test("entry reads the clock and loads the chart runtime; the document asks for the shares", () => {
		expect(names(init(ROUTE, context).commands)).toEqual(
			expect.arrayContaining(["ReadDashboardClock", "LoadChartRuntime"]),
		)
		const clocked = pageUpdate(
			init(ROUTE, context).model,
			Message.CompletedReadClock({ nowMs: NOW }),
		).model
		const received = pageUpdate(
			clocked,
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		)
		expect(received.model.status).toBe("Ready")
		expect(names(received.commands)).toEqual([FetchShares.name])
	})

	test("a missing row is the not-found state", () => {
		const missing = pageUpdate(
			init(ROUTE, context).model,
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.none() }),
		)
		expect(missing.model.status).toBe("Missing")
	})

	test("tiles fetch only once revealed, and tiles sharing a request share one fetch", () => {
		const model = ready()
		const first = pageUpdate(model, Message.RevealedWidget({ widgetId: "total-errors" }))
		expect(names(first.commands)).toEqual([FetchWidget.name])
		const second = pageUpdate(first.model, Message.RevealedWidget({ widgetId: "error-rate" }))
		expect(names(second.commands)).toEqual([])
	})

	test("a fetch answer for a superseded key is dropped", () => {
		const revealed = pageUpdate(ready(), Message.RevealedWidget({ widgetId: "total-errors" })).model
		const late = pageUpdate(
			revealed,
			Message.CompletedFetchWidget({ key: "stale", result: Result.succeed({}) }),
		)
		expect(late.model.requests).toEqual(revealed.requests)
	})

	test("an auto-refresh keeps each tile's data on screen and forgets the old window's request", () => {
		const revealed = pageUpdate(ready(), Message.RevealedWidget({ widgetId: "total-errors" })).model
		const firstKey = Object.keys(revealed.requests)[0] ?? ""
		const answered = pageUpdate(revealed, Message.CompletedFetchWidget({ key: firstKey, result: Result.succeed({ data: [] }) })).model
		const ticked = pageUpdate(answered, Message.TickedAutoRefresh()).model
		const refreshed = pageUpdate(ticked, Message.CompletedReadClock({ nowMs: NOW + 60_000 }))
		expect(names(refreshed.commands)).toContain(FetchWidget.name)
		const slots = Object.entries(refreshed.model.requests)
		expect(slots.map(([key]) => key)).not.toContain(firstKey)
		expect(slots.map(([, slot]) => slot.data._tag)).toEqual(["Refreshing"])
	})

	test("a tile whose query changed loads afresh instead of showing the old query's data", () => {
		const revealed = pageUpdate(ready(), Message.RevealedWidget({ widgetId: "total-errors" })).model
		const firstKey = Object.keys(revealed.requests)[0] ?? ""
		const answered = pageUpdate(revealed, Message.CompletedFetchWidget({ key: firstKey, result: Result.succeed({ data: [] }) })).model
		const changed = Schema.decodeUnknownSync(DashboardDocument)({
			...Schema.encodeSync(DashboardDocument)(document),
			widgets: [{ ...stat("total-errors", "totalErrors"), dataSource: { kind: "route", endpoint: "errors_by_type" } }],
		})
		const replanned = pageUpdate(answered, Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(changed) }))
		expect(names(replanned.commands)).toContain(FetchWidget.name)
		expect(Object.values(replanned.model.requests).map((slot) => slot.data._tag)).toEqual(["Loading"])
	})

	test("an auto-refresh keeps a stat's sparkline data on screen while both refresh", () => {
		const sparkline = { enabled: true, dataSource: { kind: "route", endpoint: "errors_by_type" } }
		const withSparkline = Schema.decodeUnknownSync(DashboardDocument)({
			...Schema.encodeSync(DashboardDocument)(document),
			widgets: [{ ...stat("total-errors", "totalErrors"), display: { title: "total-errors", sparkline } }],
		})
		const entered = pageUpdate(ready(), Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(withSparkline) })).model
		const revealed = pageUpdate(entered, Message.RevealedWidget({ widgetId: "total-errors" })).model
		const statKey = Object.keys(revealed.requests)[0] ?? ""
		const answer = (model: Model, key: string) =>
			pageUpdate(model, Message.CompletedFetchWidget({ key, result: Result.succeed({ data: [{ totalErrors: 5 }] }) }))
		const withStat = answer(revealed, statKey)
		expect(names(withStat.commands)).toEqual([FetchWidget.name])
		const sparkKey = Object.keys(withStat.model.requests).find((key) => key !== statKey) ?? ""
		const settled = answer(withStat.model, sparkKey).model
		const ticked = pageUpdate(settled, Message.TickedAutoRefresh()).model
		const refreshed = pageUpdate(ticked, Message.CompletedReadClock({ nowMs: NOW + 60_000 }))
		expect(names(refreshed.commands)).toEqual([FetchWidget.name, FetchWidget.name])
		const gate = refreshed.model.widgets["total-errors"]?.sparkGate
		const nextSparkKey = gate?._tag === "Request" ? gate.request.key : ""
		expect(nextSparkKey).not.toBe(sparkKey)
		expect(refreshed.model.requests[nextSparkKey]?.data._tag).toBe("Refreshing")
		expect(Object.keys(refreshed.model.requests)).toHaveLength(2)
	})

	test("picking a preset re-plans the tiles and saves the range to the board", () => {
		const revealed = pageUpdate(ready(), Message.RevealedWidget({ widgetId: "total-errors" })).model
		const picked = pageUpdate(
			revealed,
			Message.GotTimePickerMessage({ message: TimeRangePicker.Message.ClickedPreset({ value: "1h" }) }),
		)
		expect(picked.model.timeRange).toEqual({ type: "relative", value: "1h" })
		expect(names(picked.commands)).toContain(FetchWidget.name)
		expect(names(picked.commands)).toContain(SaveTimeRange.name)
	})

	test("Edit flips mode=edit in the URL and keeps the view params", () => {
		const model = routeChanged(ready(), { ...ROUTE, search: { tab: "a" } }, context).model
		expect(pageUpdate(model, Message.ClickedToggleEdit()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_platform?mode=edit&tab=a",
				isReplace: false,
			}),
		)
	})

	test("renaming writes only a changed, non-blank name", () => {
		const editing = pageUpdate(ready(), Message.ClickedTitle()).model
		expect(names(pageUpdate(editing, Message.SubmittedTitle()).commands)).toEqual([])
		const typed = pageUpdate(editing, Message.ChangedTitleDraft({ value: "  Platform v2 " })).model
		expect(names(pageUpdate(typed, Message.SubmittedTitle()).commands)).toEqual([RenameDashboard.name])
	})

	test("deleting a tile writes it away and offers Undo", () => {
		const editing = routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model
		const deleted = pageUpdate(
			editing,
			Message.GotWidgetMenuMessage({
				widgetId: "total-errors",
				message: { _tag: "ClickedItem", index: 3, item: { kind: "Item", value: "delete" } },
			}),
		)
		expect(names(deleted.commands)).toContain(RemoveWidget.name)
		expect(deleted.outMessage?._tag).toBe("RequestedToast")
		// The root runs the Undo, so it still restores after the user left the board.
		const out = deleted.outMessage
		const undo = out?._tag === "RequestedToast" ? out.rootAction?.action : undefined
		expect(undo?._tag === "RestoreDashboardWidgets" && [undo.dashboardId, undo.widgets.map((widget) => widget.id)]).toEqual([
			ROUTE.dashboardId,
			["total-errors"],
		])
	})

	test("a grip dragged past the threshold writes the tiles that moved, once, on release", () => {
		const editing = pageUpdate(
			routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model,
			Message.MeasuredGrid({ width: 1200 }),
		).model
		const pressed = pageUpdate(
			editing,
			Message.PressedGrip({ widgetId: "total-errors", clientX: 100, clientY: 100 }),
		).model
		const frame = { gridLeft: 0, gridTop: 0 }
		const clicked = pageUpdate(pressed, Message.ReleasedPointer())
		expect(names(clicked.commands)).toEqual([])
		const dragged = [400, 700].reduce(
			(model, clientX) =>
				pageUpdate(model, Message.MovedPointer({ clientX, clientY: 100, ...frame })).model,
			pressed,
		)
		expect(dragged.gesture?.isStarted).toBe(true)
		const released = pageUpdate(dragged, Message.ReleasedPointer())
		expect(names(released.commands)).toEqual([UpdateWidgetLayouts.name])
		expect(released.model.gesture).toBeNull()
	})

	test("a tile picked up with Space moves with the arrows; Escape puts it back without a write", () => {
		const editing = pageUpdate(
			routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model,
			Message.MeasuredGrid({ width: 1200 }),
		).model
		const key = (value: string, isShift = false) =>
			Message.PressedGripKey({ widgetId: "total-errors", label: "Total errors", key: value, isShift })
		const picked = pageUpdate(editing, key(" ")).model
		expect(picked.gridAnnouncement).toMatch(/^Picked up Total errors/)
		const moved = pageUpdate(picked, key("ArrowRight")).model
		const cancelled = pageUpdate(moved, key("Escape"))
		expect(names(cancelled.commands)).toEqual([])
		expect(cancelled.model.gridAnnouncement).toMatch(/^Move cancelled/)
		const dropped = pageUpdate(moved, key(" "))
		expect(names(dropped.commands)).toEqual([UpdateWidgetLayouts.name])
	})

	test("a picked preset is added and closes the picker; from view mode it also enters edit mode", () => {
		const pick = Message.ClickedWidgetPreset({ presetId: "stat-total-logs" })
		const editing = routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model
		const opened = pageUpdate(editing, Message.ClickedAddWidget()).model
		expect(opened.pickerDialog.isOpen).toBe(true)
		const added = pageUpdate(opened, pick)
		expect(names(added.commands)).toContain(AddWidget.name)
		expect(added.model.pickerDialog.isOpen).toBe(false)
		expect(added.outMessage).toBeUndefined()
		const fromView = pageUpdate(ready(), pick)
		expect(fromView.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_platform?mode=edit",
				isReplace: false,
			}),
		)
	})

	test("Tags opens the editor on the board's tags; Save writes what it holds", () => {
		const editing = routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model
		const opened = pageUpdate(
			editing,
			Message.GotMoreMenuMessage({
				message: { _tag: "ClickedItem", index: 3, item: { kind: "Item", value: "tags" } },
			}),
		).model
		expect(opened.tagEditor.dialog.isOpen).toBe(true)
		const tag = (message: TagEditor.Message) => Message.GotTagEditorMessage({ message })
		const typed = pageUpdate(opened, tag(TagEditor.Message.ChangedTagInput({ value: "SLO" }))).model
		const saved = pageUpdate(typed, tag(TagEditor.Message.ClickedSaveTags()))
		expect(names(saved.commands)).toContain(SaveTags.name)
		expect(saved.model.tagEditor.dialog.isOpen).toBe(false)
	})

	test("an auto-refresh pick rides in the URL, and in edit mode becomes the board's default", () => {
		const pick = Message.GotRefreshMenuMessage({
			message: { _tag: "ClickedItem", index: 3, item: { kind: "Radio", value: "30" } },
		})
		const viewing = pageUpdate(ready(), pick)
		expect(names(viewing.commands)).not.toContain(SaveRefreshInterval.name)
		expect(viewing.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_platform?refresh=30",
				isReplace: true,
			}),
		)
		const editing = routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model
		expect(names(pageUpdate(editing, pick).commands)).toContain(SaveRefreshInterval.name)
	})

	test("a write that saved but never synced back says so, and keeps editing on", () => {
		const behind = pageUpdate(ready(), Message.CompletedWrite({ result: Result.succeed("Behind") }))
		expect(behind.outMessage?._tag === "RequestedToast" ? behind.outMessage.title : null).toBe(
			"Saved, but this tab is behind",
		)
		expect(behind.model.persistenceError).toBeNull()
	})
})
