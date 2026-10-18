import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { FetchShares, FetchWidget, RemoveWidget, RenameDashboard, SaveTimeRange } from "./command"
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
		expect(names(init(ROUTE, context).commands)).toEqual(["ReadDashboardClock", "LoadChartRuntime"])
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
		const model = routeChanged(ready(), { ...ROUTE, search: { tab: "a" } }).model
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
		const editing = routeChanged(ready(), { ...ROUTE, search: { mode: "edit" } }).model
		const deleted = pageUpdate(
			editing,
			Message.GotWidgetMenuMessage({
				widgetId: "total-errors",
				message: { _tag: "ClickedItem", index: 3, item: { kind: "Item", value: "delete" } },
			}),
		)
		expect(names(deleted.commands)).toContain(RemoveWidget.name)
		expect(deleted.outMessage?._tag).toBe("RequestedToast")
	})
})
