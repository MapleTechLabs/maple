import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import * as TimeRangePicker from "../../kit/time-range-picker"
import type { PageContext } from "../../contract"
import { FetchWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { editedWidget, init, widgetOf } from "./update"

// `WidgetTimeRange`: under Custom, the widget's own window is picked, not frozen.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => update(current, message, context).model)

const document = Schema.decodeSync(DashboardDocument)({
	id: "dash_range",
	name: "Range",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "errors",
			visualization: "stat",
			dataSource: {
				kind: "route",
				endpoint: "errors_summary",
				transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
			},
			display: { title: "Errors", unit: "number" },
			layout: { x: 0, y: 0, w: 3, h: 2 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const custom = () =>
	run(init({ dashboardId: "dash_range", widgetId: "errors", search: {} }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		Message.ChangedTimeRangeMode({ mode: "custom" }),
	])

describe("a widget's own time range", () => {
	test("Custom starts from the board's preset as a moving window, and a picked preset replaces it", () => {
		expect(custom().state?.timeRange).toEqual({ type: "relative", value: "1h" })
		const picked = run(custom(), [
			Message.GotRangePickerMessage({
				message: TimeRangePicker.Message.ClickedPreset({ value: "1d" }),
			}),
		])
		expect(picked.state?.timeRange).toEqual({ type: "relative", value: "1d" })
		const widget = widgetOf(picked)
		expect(
			widget !== null && picked.state !== null && editedWidget(widget, picked.state, null).timeRange,
		).toEqual({
			type: "relative",
			value: "1d",
		})
	})

	test("the editor's own range picker previews locally and never writes the board", () => {
		const model = run(
			init({ dashboardId: "dash_range", widgetId: "errors", search: {} }, context).model,
			[
				Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
				Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
			],
		)
		const picked = update(
			model,
			Message.GotTimePickerMessage({ message: TimeRangePicker.Message.ClickedPreset({ value: "7d" }) }),
			context,
		)
		expect(picked.model.timeRange).toEqual({ type: "relative", value: "7d" })
		const writes = Arr.filter(picked.commands ?? [], ({ name }) => name !== FetchWidget.name)
		expect(Arr.map(writes, ({ name }) => name)).toEqual([])
		expect(widgetOf(picked.model)?.timeRange).toBeUndefined()
	})
})
