import { Option } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchLogs, FetchServices, FetchSeverities, FetchNextPage } from "./command"
import { PAGE_SIZE } from "./fetch"
import { Message } from "./message"
import type { LocalLog, Model } from "./model"
import { init, locationChanged } from "./update"
import { update } from "./update-main"
import { view as pageView } from "./view"
import { ObserveLogsViewport } from "./virtualize"

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
	hasNewDataSince: () => false,
}

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, inputs)()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

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
		expect(names(resolved.commands)).toEqual([FetchLogs.name, FetchServices.name, FetchSeverities.name])
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

	test("scrolling the last row into view fetches the next page", () => {
		const model = loaded(Array.from({ length: PAGE_SIZE }, (_, index) => log(index)))
		const short = pageUpdate(model, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } }))
		expect(names(short.commands)).toEqual([])
		const tall = pageUpdate(model, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 1500 } }))
		expect(names(tall.commands)).toEqual([FetchNextPage.name])
		expect(tall.model.isFetchingNextPage).toBe(true)
	})

	test("a row click opens the detail sheet on that log", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([log(1, "pool exhausted")])),
			Mount.resolve(ObserveLogsViewport, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })),
			expectView(role("listitem", { name: "INFO storefront: pool exhausted" })).toExist(),
		)
		const opened = pageUpdate(loaded([log(1, "pool exhausted")]), Message.ClickedLog({ log: log(1, "pool exhausted") }))
		expect(Option.map(opened.model.maybeDetail, (detail) => [detail.isOpen, detail.log.body])).toEqual(
			Option.some([true, "pool exhausted"]),
		)
		const closed = pageUpdate(opened.model, Message.ClosedDetail())
		expect(Option.map(closed.model.maybeDetail, (detail) => detail.isOpen)).toEqual(Option.some(false))
	})

	test("switching to patterns drops the list's sheet and requests the clusters", () => {
		const opened = pageUpdate(loaded([log(1)]), Message.ClickedLog({ log: log(1) })).model
		const patterns = locationChanged(opened, { ...context, location: { path: "/logs", search: "mode=patterns" } })
		expect(Option.isNone(patterns.model.maybeDetail)).toBe(true)
		expect(names(patterns.commands)).toEqual(["FetchLocalLogPatterns"])
		expect(AsyncData.isLoading(patterns.model.patterns.data)).toBe(true)
	})
})
