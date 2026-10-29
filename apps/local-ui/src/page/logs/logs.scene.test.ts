import { Option } from "effect"
import { AsyncData } from "foldkit"
import * as Animation from "@foldkit/ui/animation"
import * as Dialog from "@maple/web/ui/dialog"
import * as Tabs from "@maple/web/ui/tabs"
import { click, Command, expect as expectView, expectOutMessage, given, Mount, role, scene, text, title, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { LogsBlock } from "./block"
import { FetchLogs, FetchNextPage, FetchPatterns, FetchServices, FetchSeverities, ReadClock, RelayModeChoice } from "./command"
import { PAGE_SIZE } from "./fetch"
import { Message } from "./message"
import type { LocalLog, Model } from "./model"
import { PlaceLocalChipCard } from "./mount"
import { init } from "./update"
import { update } from "./update-main"
import { type LogsViewInputs, view as pageView } from "./view"
import { ObserveLogsViewport } from "./virtualize"
import { logKey } from "./stream"
import { WaitChipDelay } from "./update-chips"

const context: PageContext = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: "/logs", search: "" },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
}
const NOW = Date.parse("2026-10-01T12:00:30Z")

const inputs: LogsViewInputs = {
	context,
	maybePresence: Option.none(),
	lastIngestAtMs: Option.none(),
}

/** Every Message the page's graph accepts: its own and its child Blocks' generated delivery. */
type PageMessage = typeof LogsBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)
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
		expect(names(init(context).commands)).toContain(ReadClock.name)
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

	test("scrolling the last row into view fetches the next page", () => {
		const model = loaded(Array.from({ length: PAGE_SIZE }, (_, index) => log(index)))
		const short = pageUpdate(model, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } }))
		expect(names(short.commands)).toEqual([])
		const tall = pageUpdate(model, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 1500 } }))
		expect(names(tall.commands)).toEqual([FetchNextPage.name])
		expect(tall.model.isFetchingNextPage).toBe(true)
		// The pages so far travel with it, so the cache keeps them all with the new one.
		expect((tall.commands ?? []).map(({ args }) => args)).toMatchObject([{ pages: [model.logs.data._tag === "Success" ? model.logs.data.data.pages[0] : []] }])
	})

	test("a row click opens the detail sheet on that log; its trace link closes it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([log(1, "pool exhausted")])),
			Mount.resolve(ObserveLogsViewport, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })),
			expectView(role("listitem", { name: "INFO storefront: pool exhausted" })).toExist(),
		)
		const traced = { ...log(1, "pool exhausted"), traceId: "0eab694ff33721d5a836ce7444afadcc" }
		const opened = pageUpdate(loaded([traced]), Message.ClickedLog({ log: traced }))
		expect(Option.map(opened.model.maybeDetail, (sheet) => [sheet.dialog.isOpen, sheet.log.body])).toEqual(
			Option.some([true, "pool exhausted"]),
		)
		scene(
			{ update: pageUpdate, view },
			given(opened.model),
			Mount.resolve(ObserveLogsViewport, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			Mount.resolve(Tabs.MeasureTabIndicator, Tabs.Message.MeasuredIndicator({ rect: { left: 0, right: 80, top: 0, bottom: 32, width: 80, height: 32 } })),
			expectView(role("dialog")).toHaveAttr("data-open"),
			click(title(`View trace ${traced.traceId}`)),
			expectView(role("dialog")).toHaveAttr("data-closed"),
			Command.resolve(Animation.test.WaitForPaint, Animation.AnimationBlock.Message.CompletedWaitForPaint({ generation: 2 })),
			Command.resolve(Animation.test.WaitForAnimationSettled, Animation.AnimationBlock.Message.EndedAnimation({ generation: 2 })),
			Mount.expectEnded(Dialog.MountDialog),
			Mount.expectEnded(Tabs.MeasureTabIndicator),
			// The sheet stays in the page, closed, so the row stays selected.
			expectView(role("listitem", { name: "INFO storefront: pool exhausted" })).toHaveAttr("data-selected", "true"),
		)
	})

	test("switching to patterns drops the list's sheet and requests the clusters", () => {
		const opened = pageUpdate(loaded([log(1)]), Message.ClickedLog({ log: log(1) })).model
		const patterns = update(opened, Message.InformedOfLocationChange(), { ...context, location: { path: "/logs", search: "mode=patterns" } })
		expect(Option.isNone(patterns.model.maybeDetail)).toBe(true)
		expect(names(patterns.commands)).toEqual([FetchPatterns.name])
		expect(AsyncData.isLoading(patterns.model.patterns.data)).toBe(true)
	})

	test("pressing Patterns asks for the patterns mode; pressing the shown mode asks for nothing", () => {
		const model = pageUpdate(loaded([log(1)]), Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(ObserveLogsViewport, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })),
			click(role("button", { name: "Patterns" })),
			Command.resolve(RelayModeChoice, Message.ChoseMode({ value: "patterns" })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ hash: "#/logs?mode=patterns", isReplace: true })),
		)
		expect(pageUpdate(model, Message.ChoseMode({ value: "list" })).outMessage).toBeUndefined()
	})

	test("resting on a chip opens its card after the delay; leaving closes it after the grace period", () => {
		const row = { ...log(1, "payment failed"), logAttributes: { "http.status_code": "503" } }
		const model = pageUpdate(loaded([row]), Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })).model
		const chip = { index: 0, logKey: logKey(row), key: "http.status_code" }
		const entered = pageUpdate(model, Message.EnteredChip({ chip }))
		expect(names(entered.commands)).toEqual([WaitChipDelay.name])
		const generation = entered.model.chipCard.generation
		const shown = pageUpdate(entered.model, Message.ElapsedChipDelay({ generation })).model
		expect(shown.chipCard.visible).toEqual(Option.some(chip))
		scene(
			{ update: pageUpdate, view },
			given(shown),
			Mount.resolve(ObserveLogsViewport, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })),
			Mount.resolve(PlaceLocalChipCard, Message.PlacedChipCard()),
			expectView(text("Attribute")).toExist(),
			expectView(role("button", { name: "Copy http.status_code" })).toExist(),
		)
		const left = pageUpdate(shown, Message.LeftChip({ chip }))
		const closed = pageUpdate(left.model, Message.ElapsedChipDelay({ generation: left.model.chipCard.generation })).model
		expect(closed.chipCard.visible).toEqual(Option.none())
	})

	test("a JSON value expands in the card, and the next card starts collapsed", () => {
		const row = { ...log(1, "order placed"), logAttributes: { "order.payload": '{"orderId":"ord_1","total":18.5}' } }
		const model = pageUpdate(loaded([row]), Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })).model
		const chip = { index: 0, logKey: logKey(row), key: "order.payload" }
		const entered = pageUpdate(model, Message.EnteredChip({ chip })).model
		const shown = pageUpdate(entered, Message.ElapsedChipDelay({ generation: entered.chipCard.generation })).model
		const resolveMounts = [
			Mount.resolve(ObserveLogsViewport, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 800 } })),
			Mount.resolve(PlaceLocalChipCard, Message.PlacedChipCard()),
		]
		scene({ update: pageUpdate, view }, given(shown), ...resolveMounts, expectView(role("button", { name: "Copy JSON" })).toBeAbsent())
		const expanded = pageUpdate(shown, Message.ClickedChipJson()).model
		scene({ update: pageUpdate, view }, given(expanded), ...resolveMounts, expectView(role("button", { name: "Copy JSON" })).toExist())
		const closed = pageUpdate(expanded, Message.PressedChipEscape({ chip })).model
		const again = pageUpdate(closed, Message.EnteredChip({ chip })).model
		const reopened = pageUpdate(again, Message.ElapsedChipDelay({ generation: again.chipCard.generation })).model
		expect(reopened.chipCard.isJsonExpanded).toBe(false)
	})

	test("a pending open is dropped when the pointer moves on first", () => {
		const row = { ...log(1, "payment failed"), logAttributes: { "http.status_code": "503" } }
		const chip = { index: 0, logKey: logKey(row), key: "http.status_code" }
		const entered = pageUpdate(loaded([row]), Message.EnteredChip({ chip })).model
		const left = pageUpdate(entered, Message.LeftChip({ chip })).model
		expect(pageUpdate(left, Message.ElapsedChipDelay({ generation: entered.chipCard.generation })).model.chipCard.visible).toEqual(Option.none())
	})

	test("a next page in flight across a same-minute Reload is dropped when it lands", () => {
		const model = loaded(Array.from({ length: PAGE_SIZE }, (_, index) => log(index)))
		const scrolled = pageUpdate(model, Message.ChangedViewport({ viewport: { scrollTop: 0, height: 1500 } })).model
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
