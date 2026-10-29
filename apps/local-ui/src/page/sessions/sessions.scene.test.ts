import { DateTime, Option } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchFacets, FetchSessions, ReadClock } from "./command"
import { Message } from "./message"
import { PAGE_SIZE } from "./fetch"
import type { Model, SessionRow } from "./model"
import { SessionsBlock } from "./block"
import { init, update } from "./update"
import { view as pageView } from "./view"

const NOW = Date.UTC(2026, 9, 1, 12, 0, 30)
const env = { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false }
const contextAt = (search: string): PageContext => ({
	env,
	location: { path: "/sessions", search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
})
const context = contextAt("")
const inputs: PageViewInputs = {
	context,
	presenceOf: () => Option.none(),
	presenceNowMs: NOW,
	clockMs: 0,
	hasNewDataSince: () => false,
}
/** The page's complete Message, its Bindings' delivery included. */
type PageMessage = typeof SessionsBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)
/** The root's `locationChanged`, as the page hears it. */
const locationChanged = (model: Model, next: PageContext) => update(model, Message.InformedOfLocationChange(), next)
const view = withViewInputs(pageView, inputs)()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const sessionRow: SessionRow = {
	sessionId: "s",
	startTime: DateTime.makeUnsafe(NOW - 60_000),
	durationMs: 1_000,
	status: "ended",
	lastActivityAt: null,
	userId: "",
	userName: "",
	userEmail: "",
	urlInitial: "/",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	pageViews: 1,
	clickCount: 0,
	errorCount: 0,
	traceCount: 0,
}

const clocked = () => pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))

describe("local sessions list", () => {
	test("entry reads the clock, then asks for the list and its facets in the minute's window", () => {
		expect(names(init(context).commands)).toContain(ReadClock.name)
		const loaded = clocked()
		expect(names(loaded.commands)).toEqual(expect.arrayContaining([FetchSessions.name, FetchFacets.name]))
		expect(Option.getOrNull(loaded.model.maybeAnchorMs)).toBe(Date.UTC(2026, 9, 1, 12, 0, 0))
	})

	test("a list answer for superseded filters is dropped", () => {
		const first = clocked().model
		const second = locationChanged(first, contextAt("browser=Chrome")).model
		expect(second.sessions.key).not.toBe(first.sessions.key)
		const late = update(
			second,
			Message.SucceededFetchSessions({ key: first.sessions.key ?? "", data: { pages: [[]], hasNextPage: false }, fetchedAtMs: NOW }),
			contextAt("browser=Chrome"),
		)
		expect(late.model.sessions).toEqual(second.sessions)
		expect(late.model.sessionsUpdatedAtMs).toBe(second.sessionsUpdatedAtMs)
		// The stale answer is empty, but only the current list may ask for the signal presence.
		expect(late.outMessage).toBeUndefined()
		expect(names(late.commands)).toEqual([])
	})

	test("an empty list asks for the signal presence and states the fact while it is unknown", () => {
		const model = clocked().model
		const empty = pageUpdate(
			model,
			Message.SucceededFetchSessions({ key: model.sessions.key ?? "", data: { pages: [[]], hasNextPage: false }, fetchedAtMs: NOW }),
		)
		expect(empty.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
		expect(AsyncData.isSuccess(empty.model.sessions.data)).toBe(true)
		scene({ update: pageUpdate, view }, given(empty.model), expectView(text("No sessions found")).toExist())
	})

	test("Load more on the previous filter's rows waits for the new filter's list", () => {
		const model = clocked().model
		const placeholderRow = (index: number): SessionRow => ({ ...sessionRow, sessionId: `s${index}` })
		const data = { pages: [Array.from({ length: PAGE_SIZE }, (_, index) => placeholderRow(index))], hasNextPage: true }
		const full = pageUpdate(model, Message.SucceededFetchSessions({ key: model.sessions.key ?? "", data, fetchedAtMs: NOW })).model
		const filtered = contextAt("browser=Chrome")
		const pending = locationChanged(full, filtered).model
		expect(pending.sessions.isPlaceholder).toBe(true)
		expect(names(update(pending, Message.ClickedLoadMore(), filtered).commands)).toEqual([])
	})

	test("a fresh cached empty list asks for signal presence like a fetched one", () => {
		const base = clocked().model
		const cached = { data: { pages: [[]], hasNextPage: false }, updatedAtMs: NOW - 5_000, isStandIn: false, isFresh: true }
		const found = pageUpdate(base, Message.FoundCachedSessions({ key: base.sessions.key ?? "", cached }))
		expect(found.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
	})
})
