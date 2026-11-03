import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr, Record as Rec } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const fetches = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.filter(commands ?? [], ({ name }) => name === FetchWidget.name).length

const stat = (id: string, endpoint: string) => ({
	id,
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint,
		transform: { reduceToValue: { field: "value", aggregate: "first" } },
	},
	display: { title: id, unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 2 },
})

const throughput = {
	id: "throughput",
	visualization: "chart",
	dataSource: {
		kind: "query",
		resultShape: "timeseries",
		queries: [
			{
				id: "q-throughput",
				name: "Throughput",
				dataSource: "traces",
				aggregation: "count",
				whereClause: "",
				addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
				groupBy: [],
			},
		],
	},
	display: { title: "Throughput", chartId: "query-builder-area", unit: "number" },
	layout: { x: 3, y: 0, w: 6, h: 4 },
}

const boardOf = (widgets: ReadonlyArray<unknown>) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash_platform",
		name: "Platform overview",
		timeRange: { type: "relative", value: "6h" },
		widgets,
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const run = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const ready = (widgets: ReadonlyArray<unknown>): Model =>
	run(init({ dashboardId: "dash_platform", search: {} }, context).model, [
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(boardOf(widgets)) }),
	])

/** Every held request answered. */
const answered = (model: Model): Model =>
	run(
		model,
		Arr.map(Rec.keys(model.requests), (key) =>
			Message.CompletedFetchWidget({ key, result: Result.succeed({ data: [{ value: 1 }] }) }),
		),
	)

const requestKeyOf = (model: Model, widgetId: string) => {
	const gate = model.widgets[widgetId]?.gate
	return gate?._tag === "Request" ? gate.request.key : null
}

const tick = (model: Model) =>
	pageUpdate(run(model, [Message.TickedAutoRefresh()]), Message.CompletedReadClock({ nowMs: NOW + 60_000 }))

describe("dashboard refresh", () => {
	test("an auto-refresh refetches only tiles in view; a scrolled-away tile fetches once it is back", () => {
		const revealed = answered(
			run(ready([stat("errors", "errors_summary"), stat("types", "errors_by_type")]), [
				Message.RevealedWidget({ widgetId: "errors" }),
				Message.RevealedWidget({ widgetId: "types" }),
			]),
		)
		const hidden = run(revealed, [Message.HidWidget({ widgetId: "types" })])
		const refreshed = tick(hidden)
		expect(fetches(refreshed.commands)).toBe(1)
		expect(requestKeyOf(refreshed.model, "types")).toBe(requestKeyOf(revealed, "types"))
		const back = pageUpdate(refreshed.model, Message.RevealedWidget({ widgetId: "types" }))
		expect(fetches(back.commands)).toBe(1)
		expect(requestKeyOf(back.model, "types")).not.toBe(requestKeyOf(revealed, "types"))
	})

	test("a tile scrolled away with nothing new to fetch asks for nothing when it is back", () => {
		const revealed = answered(
			run(ready([stat("errors", "errors_summary")]), [Message.RevealedWidget({ widgetId: "errors" })]),
		)
		const away = run(revealed, [Message.HidWidget({ widgetId: "errors" })])
		expect(fetches(pageUpdate(away, Message.RevealedWidget({ widgetId: "errors" })).commands)).toBe(0)
	})

	test("a refresh waits for a tile's pending request, then fetches the new window once it answers", () => {
		const revealed = run(ready([stat("errors", "errors_summary")]), [
			Message.RevealedWidget({ widgetId: "errors" }),
		])
		const ticked = tick(revealed)
		expect(fetches(ticked.commands)).toBe(0)
		const key = requestKeyOf(ticked.model, "errors") ?? ""
		const settled = pageUpdate(
			ticked.model,
			Message.CompletedFetchWidget({ key, result: Result.succeed({ data: [{ value: 1 }] }) }),
		)
		expect(fetches(settled.commands)).toBe(1)
		expect(requestKeyOf(settled.model, "errors")).not.toBe(key)
		expect(fetches(tick(answered(settled.model)).commands)).toBe(1)
	})

	test("a resize that keeps the chart's bucket keeps its request; one that changes it refetches", () => {
		const revealed = answered(
			run(ready([throughput]), [
				Message.RevealedWidget({ widgetId: "throughput" }),
				Message.MeasuredWidget({ widgetId: "throughput", widthPx: 800 }),
			]),
		)
		// Six hours over 700 or 800 points both round to one-minute buckets.
		const narrower = pageUpdate(
			revealed,
			Message.MeasuredWidget({ widgetId: "throughput", widthPx: 700 }),
		)
		expect(fetches(narrower.commands)).toBe(0)
		expect(requestKeyOf(narrower.model, "throughput")).toBe(requestKeyOf(revealed, "throughput"))
		// Over 200 points they round to two-minute buckets.
		const narrow = pageUpdate(
			narrower.model,
			Message.MeasuredWidget({ widgetId: "throughput", widthPx: 200 }),
		)
		expect(fetches(narrow.commands)).toBe(1)
		expect(requestKeyOf(narrow.model, "throughput")).not.toBe(requestKeyOf(revealed, "throughput"))
	})
})
