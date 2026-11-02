import { Option } from "effect"
import { AsyncData } from "foldkit"
import { click, expect as expectView, expectOutMessage, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchLogs, FetchServices, FetchSeverities, FetchNextPage } from "./command"
import { PAGE_SIZE } from "./fetch"
import { Message as LogSheetMessage } from "../kit/log-sheet/message"
import { Message } from "./message"
import type { LocalLog, Model } from "./model"
import { init, locationChanged } from "./update"
import { update } from "./update-main"
import { view as pageView } from "./view"
import * as AttributesPanel from "@maple/views/ui/attributes/attributes-panel"
import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import { VirtualizeLogStream } from "@maple/views/ui/logs/virtualize"
import { PageOutMessage } from "../contract"

const context: PageContext = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: "/logs", search: "" },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
}
const NOW = Date.parse("2026-10-01T12:00:30Z")

const inputs: PageViewInputs = {
	context,
	presenceOf: () => Option.none(),
	presenceNowMs: NOW,
	clockMs: 0,
	hasNewDataSince: () => false,
}

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, inputs)()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

/** The virtualizer reports rows `from..to` (the stream's own Message, as its Mount sends it). */
const streamWindow = (from: number, to: number) =>
	LogsStream.Message.ChangedVirtualWindow({
		rows: Array.from({ length: to - from + 1 }, (_, i) => ({ index: from + i, start: (from + i) * 30 })),
		totalSize: (to + 1) * 30,
	})
const windowOf = (from: number, to: number) => Message.GotStreamMessage({ message: streamWindow(from, to) })

const log = (index: number, body = `GET /item/${index} 200`): LocalLog => ({
	timestamp: `2026-10-01 11:59:${String(59 - (index % 60)).padStart(2, "0")}.000000000`,
	severityText: "INFO",
	severityNumber: 9,
	serviceName: "storefront",
	body,
	traceId: "",
	spanId: "",
	recordIdentity: String(index),
	logAttributes: {},
	resourceAttributes: {},
})

/** Entered with the clock read: every query in flight. */
const entered = (): Model => pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW })).model

const loaded = (rows: ReadonlyArray<LocalLog>): Model => {
	const base = entered()
	return pageUpdate(
		base,
		Message.SucceededFetchLogs({ key: base.logs.key ?? "", data: { pages: [rows], hasNextPage: rows.length === PAGE_SIZE }, fetchedAtMs: NOW }),
	).model
}

describe("local logs", () => {
	test("entry reads the clock, then asks for the list and both facets", () => {
		expect(names(init(context).commands)).toContain("ReadLogsClock")
		const resolved = pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))
		expect(names(resolved.commands)).toEqual(expect.arrayContaining([FetchLogs.name, FetchServices.name, FetchSeverities.name]))
	})

	test("a list answer for a superseded window is dropped", () => {
		const first = entered()
		const second = pageUpdate(first, Message.CompletedReadRefreshClock({ nowMs: NOW + 60_000 })).model
		const late = pageUpdate(
			second,
			Message.SucceededFetchLogs({ key: first.logs.key ?? "", data: { pages: [[log(1)]], hasNextPage: false }, fetchedAtMs: NOW }),
		)
		expect(late.model.logs).toEqual(second.logs)
	})

	test("an empty window asks the root for signal presence and says no logs were found", () => {
		const base = entered()
		const empty = pageUpdate(
			base,
			Message.SucceededFetchLogs({ key: base.logs.key ?? "", data: { pages: [[]], hasNextPage: false }, fetchedAtMs: NOW }),
		)
		expect(empty.outMessage?._tag).toBe("RequestedSignalPresence")
		scene({ update: pageUpdate, view }, given(empty.model), expectView(text("No logs found")).toExist())
	})

	test("the stream rendering the last loaded row fetches the next page", () => {
		const model = loaded(Array.from({ length: PAGE_SIZE }, (_, index) => log(index)))
		const short = pageUpdate(model, windowOf(0, 20))
		expect(names(short.commands)).toEqual([])
		const tall = pageUpdate(model, windowOf(0, PAGE_SIZE - 1))
		expect(names(tall.commands)).toEqual([FetchNextPage.name])
		expect(tall.model.isFetchingNextPage).toBe(true)
		// The pages so far travel with it, so the cache keeps them all with the new one.
		expect((tall.commands ?? []).map(({ args }) => args)).toMatchObject([{ pages: [model.logs.data._tag === "Success" ? model.logs.data.data.pages[0] : []] }])
	})

	test("a next page keeps an expanded row open; new data closes it", () => {
		const model = loaded(Array.from({ length: PAGE_SIZE }, (_, index) => log(index)))
		const expanded = pageUpdate(model, Message.GotStreamMessage({ message: LogsStream.Message.ClickedExpand({ index: 3 }) })).model
		const fetching = pageUpdate(expanded, windowOf(0, PAGE_SIZE - 1)).model
		const more = pageUpdate(
			fetching,
			Message.SucceededFetchNextPage({ key: fetching.logs.key ?? "", generation: fetching.pageGeneration, page: [log(99)] }),
		).model
		expect([more.stream.rows.length, more.stream.expandedRows]).toEqual([PAGE_SIZE + 1, [3]])
		const refetched = pageUpdate(
			more,
			Message.SucceededFetchLogs({ key: more.logs.key ?? "", data: { pages: [[log(1)]], hasNextPage: false }, fetchedAtMs: NOW + 1 }),
		).model
		expect([refetched.stream.rows.length, refetched.stream.expandedRows]).toEqual([1, []])
	})

	test("a row click opens the detail sheet on that log", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([log(1, "pool exhausted")])),
			Mount.resolve(VirtualizeLogStream, streamWindow(0, 0)),
			expectView(role("listitem")).toExist(),
			expectView(text("pool exhausted")).toExist(),
			expectView(text("1 log")).toExist(),
		)
		const opened = pageUpdate(loaded([log(1, "pool exhausted")]), Message.GotStreamMessage({ message: LogsStream.Message.ClickedRow({ index: 0 }) }))
		expect(Option.map(opened.model.maybeDetail, (sheet) => [sheet.dialog.isOpen, sheet.log.body])).toEqual(
			Option.some([true, "pool exhausted"]),
		)
		const closed = pageUpdate(opened.model, Message.GotLogSheetMessage({ message: LogSheetMessage.ClosedSheet() }))
		expect(Option.map(closed.model.maybeDetail, (sheet) => sheet.dialog.isOpen)).toEqual(Option.some(false))
	})

	test("switching to patterns drops the list's sheet and requests the clusters", () => {
		const opened = pageUpdate(loaded([log(1)]), Message.GotStreamMessage({ message: LogsStream.Message.ClickedRow({ index: 0 }) })).model
		const patterns = locationChanged(opened, { ...context, location: { path: "/logs", search: "mode=patterns" } })
		expect(Option.isNone(patterns.model.maybeDetail)).toBe(true)
		expect(names(patterns.commands)).toEqual(["FetchLocalLogPatterns"])
		expect(AsyncData.isLoading(patterns.model.patterns.data)).toBe(true)
	})

	test("filtering by an attribute adds it to the hash; its chip removes it", () => {
		const row = { ...log(1, "payment failed"), logAttributes: { "http.status_code": "503" } }
		const model = loaded([row])
		const expanded = pageUpdate(model, Message.GotStreamMessage({ message: LogsStream.Message.ClickedExpand({ index: 0 }) })).model
		const filter = AttributesPanel.Message.ClickedFilter({ source: "log", key: "http.status_code", value: "503", negated: false })
		const chosen = pageUpdate(expanded, Message.GotStreamMessage({ message: LogsStream.Message.GotPanelMessage({ index: 0, message: filter }) }))
		expect(chosen.outMessage).toEqual(PageOutMessage.RequestedNavigation({ hash: "#/logs?attrs=log%3Ahttp.status_code%3D503", isReplace: true }))
		const filtered = { ...context, location: { path: "/logs", search: "attrs=log%3Ahttp.status_code%3D503" } }
		const requested = locationChanged(model, filtered)
		expect(names(requested.commands)).toEqual(expect.arrayContaining([FetchLogs.name]))
		scene(
			{ update: (m: Model, message: Message) => update(m, message, filtered), view: withViewInputs(pageView, { ...inputs, context: filtered })() },
			given(requested.model),
			Mount.resolve(VirtualizeLogStream, streamWindow(0, 0)),
			expectView(text("http.status_code")).toExist(),
			click(role("button", { name: /Remove/ })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ hash: "#/logs", isReplace: true })),
		)
	})

	test("removing a filter drops every spelling of it and keeps the others", () => {
		const search = "attrs=log%3Ak%3Dv&attrs=log%3Ak%3Dv&attrs=%21res%3Aregion%3Deu"
		const repeated = { ...context, location: { path: "/logs", search } }
		const removed = update(entered(), Message.RemovedAttributeFilter({ source: "log", key: "k", value: "v", negated: false }), repeated)
		expect(removed.outMessage).toEqual(PageOutMessage.RequestedNavigation({ hash: "#/logs?attrs=%21res%3Aregion%3Deu", isReplace: true }))
	})

	test("pinning a column gives every row its cell; density and wrap are saved", () => {
		const row = { ...log(1), resourceAttributes: { "deployment.environment": "staging" } }
		const model = loaded([row])
		expect(model.columnOptions).toEqual([{ name: "deployment.environment", count: 1 }])
		const pin = pageUpdate(model, Message.ToggledColumn({ key: "deployment.environment" }))
		expect(pin.outMessage).toEqual(PageOutMessage.RequestedNavigation({ hash: "#/logs?columns=deployment.environment", isReplace: true }))
		const pinned = locationChanged(model, { ...context, location: { path: "/logs", search: "columns=deployment.environment" } }).model
		expect(pinned.stream.rows.map((r) => r.pinned.map((cell) => cell.value))).toEqual([["staging"]])
		const comfortable = pageUpdate(model, Message.ClickedDensity())
		expect([comfortable.model.density, names(comfortable.commands)]).toEqual(["comfortable", ["SaveLocalLogsPreferences"]])
	})

	test("a next page in flight across a same-minute Reload is dropped when it lands", () => {
		const model = loaded(Array.from({ length: PAGE_SIZE }, (_, index) => log(index)))
		const scrolled = pageUpdate(model, windowOf(0, PAGE_SIZE - 1)).model
		const reloaded = pageUpdate(scrolled, Message.CompletedReadRefreshClock({ nowMs: NOW })).model
		const late = Message.SucceededFetchNextPage({ key: reloaded.logs.key ?? "", generation: scrolled.pageGeneration, page: [log(99)] })
		expect(pageUpdate(reloaded, late).model.logs).toEqual(reloaded.logs)
	})

	test("a fresh cached empty window asks for signal presence like a fetched one", () => {
		const base = entered()
		const cached = { data: { pages: [[]], hasNextPage: false }, updatedAtMs: NOW - 5_000, isStandIn: false, isFresh: true }
		const found = pageUpdate(base, Message.FoundCachedLogs({ key: base.logs.key ?? "", cached }))
		expect(found.outMessage?._tag).toBe("RequestedSignalPresence")
	})
})
