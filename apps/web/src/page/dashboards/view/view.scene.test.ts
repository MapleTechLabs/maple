import { timeRangeOf } from "./plan"
import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr, Record as Rec } from "effect"
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
	Arr.map(commands ?? [], ({ name }) => name)

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
	Arr.reduce(
		[
			Message.CompletedReadClock({ nowMs: NOW }),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		],
		init(ROUTE, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

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
		const firstKey = Rec.keys(revealed.requests)[0] ?? ""
		const answered = pageUpdate(
			revealed,
			Message.CompletedFetchWidget({ key: firstKey, result: Result.succeed({ data: [] }) }),
		).model
		const ticked = pageUpdate(answered, Message.TickedAutoRefresh()).model
		const refreshed = pageUpdate(ticked, Message.CompletedReadClock({ nowMs: NOW + 60_000 }))
		expect(names(refreshed.commands)).toContain(FetchWidget.name)
		const slots = Rec.toEntries(refreshed.model.requests)
		expect(Arr.map(slots, ([key]) => key)).not.toContain(firstKey)
		expect(Arr.map(slots, ([, slot]) => slot.data._tag)).toEqual(["Refreshing"])
	})

	test("a tile whose query changed loads afresh instead of showing the old query's data", () => {
		const revealed = pageUpdate(ready(), Message.RevealedWidget({ widgetId: "total-errors" })).model
		const firstKey = Rec.keys(revealed.requests)[0] ?? ""
		const answered = pageUpdate(
			revealed,
			Message.CompletedFetchWidget({ key: firstKey, result: Result.succeed({ data: [] }) }),
		).model
		const changed = Schema.decodeUnknownSync(DashboardDocument)({
			...Schema.encodeSync(DashboardDocument)(document),
			widgets: [
				{
					...stat("total-errors", "totalErrors"),
					dataSource: { kind: "route", endpoint: "errors_by_type" },
				},
			],
		})
		const replanned = pageUpdate(
			answered,
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(changed) }),
		)
		expect(names(replanned.commands)).toContain(FetchWidget.name)
		expect(Arr.map(Rec.values(replanned.model.requests), (slot) => slot.data._tag)).toEqual(["Loading"])
	})

	test("an auto-refresh keeps a stat's sparkline data on screen while both refresh", () => {
		const sparkline = { enabled: true, dataSource: { kind: "route", endpoint: "errors_by_type" } }
		const withSparkline = Schema.decodeUnknownSync(DashboardDocument)({
			...Schema.encodeSync(DashboardDocument)(document),
			widgets: [
				{ ...stat("total-errors", "totalErrors"), display: { title: "total-errors", sparkline } },
			],
		})
		const entered = pageUpdate(
			ready(),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(withSparkline) }),
		).model
		const revealed = pageUpdate(entered, Message.RevealedWidget({ widgetId: "total-errors" }))
		// The sparkline does not wait for the stat's value: both are asked for in one pass.
		expect(names(revealed.commands)).toEqual([FetchWidget.name, FetchWidget.name])
		const [statKey = "", sparkKey = ""] = Rec.keys(revealed.model.requests)
		const answer = (model: Model, key: string) =>
			pageUpdate(
				model,
				Message.CompletedFetchWidget({ key, result: Result.succeed({ data: [{ totalErrors: 5 }] }) }),
			)
		const settled = answer(answer(revealed.model, statKey).model, sparkKey).model
		const ticked = pageUpdate(settled, Message.TickedAutoRefresh()).model
		const refreshed = pageUpdate(ticked, Message.CompletedReadClock({ nowMs: NOW + 60_000 }))
		expect(names(refreshed.commands)).toEqual([FetchWidget.name, FetchWidget.name])
		const gate = refreshed.model.widgets["total-errors"]?.sparkGate
		const nextSparkKey = gate?._tag === "Request" ? gate.request.key : ""
		expect(nextSparkKey).not.toBe(sparkKey)
		expect(refreshed.model.requests[nextSparkKey]?.data._tag).toBe("Refreshing")
		expect(Rec.keys(refreshed.model.requests)).toHaveLength(2)
	})

	test("one tile's answer leaves every other tile's slot as it was, so only that tile redraws", () => {
		const revealed = Arr.reduce(
			[
				Message.RevealedWidget({ widgetId: "total-errors" }),
				Message.RevealedWidget({ widgetId: "error-rate" }),
			],
			ready(),
			(model, message) => pageUpdate(model, message).model,
		)
		const totalGate = revealed.widgets["total-errors"]?.gate
		const key = totalGate?._tag === "Request" ? totalGate.request.key : ""
		const answered = pageUpdate(
			revealed,
			Message.CompletedFetchWidget({ key, result: Result.succeed({ data: [{ totalErrors: 5 }] }) }),
		)
		expect(names(answered.commands)).toEqual([])
		expect(answered.model.requests[key]?.data._tag).toBe("Success")
		expect(answered.model.widgets).toBe(revealed.widgets)
		const refreshed = pageUpdate(
			pageUpdate(answered.model, Message.TickedAutoRefresh()).model,
			Message.CompletedReadClock({ nowMs: NOW }),
		).model
		// Same clock, same window: the re-plan lands on the same keys and keeps each slot.
		expect(refreshed.widgets["error-rate"]).toBe(revealed.widgets["error-rate"])
	})

	const pickPreset = (model: Model, value: string) =>
		pageUpdate(
			model,
			Message.GotTimePickerMessage({ message: TimeRangePicker.Message.ClickedPreset({ value }) }),
		)
	const endTimeOf = (model: Model, widgetId: string) => {
		const gate = model.widgets[widgetId]?.gate
		return gate?._tag === "Request" ? gate.request.params.endTime : undefined
	}

	test("a viewer's pick goes to their URL, not the board, and plans on a fresh clock", () => {
		const revealed = pageUpdate(ready(), Message.RevealedWidget({ widgetId: "total-errors" })).model
		const picked = pickPreset(revealed, "1h")
		expect(names(picked.commands)).not.toContain(SaveTimeRange.name)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_platform?range=1h",
				isReplace: true,
			}),
		)
		const routed = routeChanged(picked.model, { ...ROUTE, search: { range: "1h" } }, context)
		// Two hours after entry: the window ends now, not when the page was opened.
		expect(names(routed.commands)).toEqual(["ReadDashboardClock"])
		const clocked = pageUpdate(routed.model, Message.CompletedReadClock({ nowMs: NOW + 2 * 3_600_000 }))
		expect(names(clocked.commands)).toContain(FetchWidget.name)
		expect(endTimeOf(clocked.model, "total-errors")).toMatch(/^2026-10-01 14:/)
	})

	test("a viewer's pick of the board's own range still lands in their URL", () => {
		const board = ready().document?.timeRange
		const value = board?.type === "relative" ? board.value : ""
		const picked = pickPreset(ready(), value)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/dashboards/dash_platform?range=${value}`,
				isReplace: true,
			}),
		)
		const routed = routeChanged(picked.model, { ...ROUTE, search: { range: value } }, context).model
		expect(pickPreset(routed, value).outMessage).toBeUndefined()
	})

	test("an edit session's pick is also saved as the board's range", () => {
		const editing = routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model
		const picked = pickPreset(editing, "1h")
		expect(names(picked.commands)).toContain(SaveTimeRange.name)
		// The saved board answers through the document; the URL keeps no range in edit mode.
		expect(picked.outMessage).toBeUndefined()
	})

	test("an edit session works on the board's range, not a viewer's URL pick", () => {
		const viewing = routeChanged(ready(), { ...ROUTE, search: { range: "7d", tab: "a" } }, context).model
		expect(pageUpdate(viewing, Message.ClickedToggleEdit()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_platform?mode=edit&tab=a",
				isReplace: false,
			}),
		)
		const editing = routeChanged(
			ready(),
			{ ...ROUTE, search: { mode: "edit", range: "7d" } },
			context,
		).model
		expect(timeRangeOf(editing)).toEqual(editing.document?.timeRange)
	})

	test("the URL's range wins over the board's, and a range it cannot read falls back to the board's", () => {
		const fromUrl = routeChanged(ready(), { ...ROUTE, search: { range: "15m" } }, context).model
		const clocked = pageUpdate(
			pageUpdate(fromUrl, Message.CompletedReadClock({ nowMs: NOW })).model,
			Message.RevealedWidget({ widgetId: "total-errors" }),
		).model
		const gate = clocked.widgets["total-errors"]?.gate
		const params = gate?._tag === "Request" ? gate.request.params : {}
		expect(Date.parse(`${String(params.endTime)}Z`) - Date.parse(`${String(params.startTime)}Z`)).toBe(
			15 * 60_000,
		)
		const garbled = routeChanged(ready(), { ...ROUTE, search: { range: "soon", from: 7 } }, context)
		expect(names(garbled.commands)).toEqual([])
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
		expect(
			undo?._tag === "RestoreDashboardWidgets" && [
				undo.dashboardId,
				Arr.map(undo.widgets, (widget) => widget.id),
			],
		).toEqual([ROUTE.dashboardId, ["total-errors"]])
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
		const dragged = Arr.reduce(
			[400, 700],
			pressed,
			(model, clientX) =>
				pageUpdate(model, Message.MovedPointer({ clientX, clientY: 100, ...frame })).model,
		)
		expect(dragged.gesture?.isStarted).toBe(true)
		const released = pageUpdate(dragged, Message.ReleasedPointer())
		expect(names(released.commands)).toEqual([UpdateWidgetLayouts.name])
		expect(released.model.gesture).toBeNull()
	})

	test("a window narrowed into another tier mid-drag cancels the drag instead of saving a projection", () => {
		const editing = pageUpdate(
			routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model,
			Message.MeasuredGrid({ width: 1200 }),
		).model
		const pressed = pageUpdate(
			editing,
			Message.PressedGrip({ widgetId: "total-errors", clientX: 100, clientY: 100 }),
		).model
		const dragged = pageUpdate(
			pressed,
			Message.MovedPointer({ clientX: 700, clientY: 100, gridLeft: 0, gridTop: 0 }),
		).model
		expect(dragged.gesture?.isStarted).toBe(true)
		const narrowed = pageUpdate(dragged, Message.MeasuredGrid({ width: 500 })).model
		expect(narrowed.gesture).toBeNull()
		const released = pageUpdate(narrowed, Message.ReleasedPointer())
		expect(names(released.commands)).toEqual([])
	})

	test("a tap whose release was missed does not hijack the next drag", () => {
		const editing = pageUpdate(
			routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model,
			Message.MeasuredGrid({ width: 1200 }),
		).model
		// The release came before the window listeners attached, so no ReleasedPointer arrives.
		const tapped = pageUpdate(
			editing,
			Message.PressedGrip({ widgetId: "total-errors", clientX: 100, clientY: 100 }),
		).model
		const pressed = pageUpdate(
			tapped,
			Message.PressedGrip({ widgetId: "error-rate", clientX: 400, clientY: 100 }),
		).model
		expect(pressed.gesture?.widgetId).toBe("error-rate")
		const dragged = pageUpdate(
			pressed,
			Message.MovedPointer({ clientX: 1000, clientY: 100, gridLeft: 0, gridTop: 0 }),
		).model
		const released = pageUpdate(dragged, Message.ReleasedPointer())
		expect(names(released.commands)).toEqual([UpdateWidgetLayouts.name])
		const xOf = (id: string) =>
			Option.getOrUndefined(
				Option.map(
					Arr.findFirst(released.model.layoutWrite?.layout ?? [], (item) => item.i === id),
					(item) => item.x,
				),
			)
		expect(xOf("total-errors")).toBe(0)
		expect(xOf("error-rate")).toBeGreaterThan(0)
	})

	test("a window narrowed during a keyboard move puts the tile back without a write", () => {
		const editing = pageUpdate(
			routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }, context).model,
			Message.MeasuredGrid({ width: 1200 }),
		).model
		const key = (value: string) =>
			Message.PressedGripKey({
				widgetId: "total-errors",
				label: "Total errors",
				key: value,
				isShift: false,
			})
		const moved = pageUpdate(pageUpdate(editing, key(" ")).model, key("ArrowRight")).model
		const narrowed = pageUpdate(moved, Message.MeasuredGrid({ width: 500 }))
		expect(narrowed.model.keyboardMove).toBeNull()
		expect(names(narrowed.commands)).toEqual([])
		expect(narrowed.model.gridAnnouncement).toMatch(/^Move cancelled/)
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
		// A viewer's own range stays behind: edit mode works on the board's saved range.
		const ranged = routeChanged(ready(), { ...ROUTE, search: { range: "7d", tab: "a" } }, context).model
		expect(pageUpdate(ranged, pick).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_platform?mode=edit&tab=a",
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
