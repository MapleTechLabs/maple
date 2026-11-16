import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { makeRawSqlDataSource } from "@maple/widgets/dashboard"
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

const boardOf = (widgets: ReadonlyArray<unknown>, range = "6h") =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash_platform",
		name: "Platform overview",
		timeRange: { type: "relative", value: range },
		widgets,
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const run = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const ready = (widgets: ReadonlyArray<unknown>, range?: string): Model =>
	run(init({ dashboardId: "dash_platform", search: {} }, context).model, [
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(boardOf(widgets, range)) }),
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

const tick = (model: Model, nowMs = NOW + 60_000) =>
	pageUpdate(run(model, [Message.TickedAutoRefresh()]), Message.CompletedReadClock({ nowMs }))

const reloadAt = (model: Model, nowMs: number) =>
	pageUpdate(run(model, [Message.ClickedReload()]), Message.CompletedReadClock({ nowMs }))

const sqlTile = (id: string, timeRange?: unknown) => ({
	id,
	visualization: "stat",
	dataSource: makeRawSqlDataSource({
		sql: `SELECT count() AS value, '${id}' AS tile FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)`,
	}),
	display: { title: id, unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 2 },
	...(timeRange === undefined ? undefined : { timeRange }),
})

/** Answers each tick's fetches, ticking every `everyMs` for `forMs`; returns how many it fetched. */
const fetchesOverTicks = (start: Model, everyMs: number, forMs: number): number =>
	Arr.reduce(
		Arr.makeBy(Math.floor(forMs / everyMs), (i) => NOW + (i + 1) * everyMs),
		{ model: start, total: 0 },
		(state, nowMs) => {
			const ticked = tick(state.model, nowMs)
			return { model: answered(ticked.model), total: state.total + fetches(ticked.commands) }
		},
	).total

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
		expect(fetches(tick(answered(settled.model), NOW + 120_000).commands)).toBe(1)
	})

	test("a 30-day raw SQL board ticking every 10s fetches once per 30-minute grid step, not per tick", () => {
		const board = answered(
			run(ready([sqlTile("orders")], "30d"), [Message.RevealedWidget({ widgetId: "orders" })]),
		)
		expect(fetchesOverTicks(board, 10_000, 60 * 60_000)).toBe(2)
	})

	test("a tick that leaves the snapped window where it was asks for nothing", () => {
		const board = answered(
			run(ready([sqlTile("orders")]), [Message.RevealedWidget({ widgetId: "orders" })]),
		)
		const ticked = tick(board, NOW + 30_000)
		expect(fetches(ticked.commands)).toBe(0)
		expect(requestKeyOf(ticked.model, "orders")).toBe(requestKeyOf(board, "orders"))
	})

	test("an explicit Reload refetches at the true now, even within the same grid step", () => {
		const board = answered(
			run(ready([sqlTile("orders")]), [Message.RevealedWidget({ widgetId: "orders" })]),
		)
		const reloaded = reloadAt(board, NOW + 30_000)
		expect(fetches(reloaded.commands)).toBe(1)
		expect(requestKeyOf(reloaded.model, "orders")).not.toBe(requestKeyOf(board, "orders"))
	})

	test("ticks after a Reload return to the snapped grid once, then hold until it moves", () => {
		const board = answered(
			run(ready([sqlTile("orders")]), [Message.RevealedWidget({ widgetId: "orders" })]),
		)
		const reloaded = answered(reloadAt(board, NOW + 30_000).model)
		const back = tick(reloaded, NOW + 40_000)
		expect(fetches(back.commands)).toBe(1)
		expect(requestKeyOf(back.model, "orders")).toBe(requestKeyOf(board, "orders"))
		expect(fetches(tick(answered(back.model), NOW + 50_000).commands)).toBe(0)
	})

	test("a tile pinned to its own range resolves it on the clock read, so ticks share its key", () => {
		const board = answered(
			run(ready([sqlTile("recent", { type: "relative", value: "1h" })]), [
				Message.RevealedWidget({ widgetId: "recent" }),
			]),
		)
		const sameStep = tick(board, NOW + 10_000)
		expect(fetches(sameStep.commands)).toBe(0)
		expect(fetches(tick(answered(sameStep.model), NOW + 15_000).commands)).toBe(1)
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
