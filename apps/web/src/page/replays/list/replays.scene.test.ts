import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import {
	Command,
	expect as expectView,
	find,
	given,
	label,
	Mount,
	scene,
	tap,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import type { SessionRow } from "../kit/session-row"
import { FetchFacets, FetchFirstPage, FetchNextPage, filterInputs, VirtualizeList, WatchListEnd } from "./command"
import { allRows } from "./derive"
import { Message } from "./message"
import type { Model, ReplaysFacets, ReplaysPage } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-09-30 12:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const session = (sessionId: string, userName = ""): SessionRow => ({
	sessionId,
	startTime: "2026-10-01 11:00:00",
	durationMs: 60_000,
	status: "ended",
	lastActivityAt: "2026-10-01 11:01:00",
	userId: null,
	userName,
	userEmail: "",
	groupId: "",
	groupName: "",
	urlInitial: "https://shop.acme.test/cart",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	country: "US",
	serviceName: "storefront",
	pageViews: 2,
	clickCount: 3,
	errorCount: 0,
	traceCount: 0,
	recorded: "true",
	tags: ["engaged"],
})

const page = (rows: ReadonlyArray<SessionRow>, nextCursor: string | null = null): ReplaysPage => ({
	rows,
	hasMore: nextCursor !== null,
	nextCursor,
})

const facets: ReplaysFacets = {
	services: [{ name: "storefront", count: 2 }],
	browsers: [{ name: "Chrome", count: 2 }],
	countries: [],
	devices: [],
	groups: [],
	pages: [],
	tags: [{ name: "engaged", count: 2 }],
	errorCount: 0,
	totalSessions: 2,
	liveSessions: 0,
	durationBuckets: [],
	durationP50: 30_000,
	durationP95: 90_000,
}

const windowed = (search = {}): Model =>
	pageUpdate(init({ search }, context).model, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }))
		.model

const loaded = (first: ReplaysPage, search = {}): Model => {
	const base = windowed(search)
	return [
		Message.CompletedFetchFacets({ key: base.facets.key ?? "", result: Result.succeed(facets) }),
		Message.CompletedFetchFirstPage({ key: base.firstPage.key ?? "", result: Result.succeed(first) }),
	].reduce((model, message) => pageUpdate(model, message).model, base)
}

const rowsWindow = (count: number) =>
	Message.ChangedVirtualWindow({
		window: {
			rows: Array.from({ length: count }, (_, i) => ({ index: i, start: i * 59, end: (i + 1) * 59 })),
			totalSize: count * 59,
			scrollMargin: 0,
		},
	})

const withPresence = (model: Model, status: "present" | "absent"): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({ sessions: { status, lastSeenMs: null } }),
		}),
	).model

describe("replays list", () => {
	test("entry resolves the window, then asks for the first page and the facets", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("ResolveReplaysWindow")
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(expect.arrayContaining([FetchFirstPage.name, FetchFacets.name]))
	})

	test("a first page for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(first, Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }))
		const late = pageUpdate(
			second.model,
			Message.CompletedFetchFirstPage({ key: first.firstPage.key ?? "", result: Result.succeed(page([session("a")])) }),
		)
		expect(allRows(late.model)).toEqual([])
	})

	test("reaching the end asks for the next page by cursor, once", () => {
		const model = loaded(page([session("a")], "cursor-1"))
		const asked = pageUpdate(model, Message.ReachedListEnd())
		expect(names(asked.commands)).toEqual([FetchNextPage.name])
		expect(names(pageUpdate(asked.model, Message.ReachedListEnd()).commands)).toEqual([])
		expect(names(pageUpdate(loaded(page([session("a")])), Message.ReachedListEnd()).commands)).toEqual([])
	})

	test("page 2 under a new search waits for its own first page and its cursor", () => {
		const model = loaded(page([session("a")], "cursor-1"))
		const filtered = routeChanged(model, { search: { browser: "Safari" } }, context).model
		const moved = pageUpdate(filtered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model
		expect(names(pageUpdate(moved, Message.ReachedListEnd()).commands)).toEqual([])
		const own = Message.CompletedFetchFirstPage({ key: moved.firstPage.key ?? "", result: Result.succeed(page([session("b")], "cursor-2")) })
		const settled = pageUpdate(moved, own).model
		expect(pageUpdate(settled, Message.ReachedListEnd()).commands?.[0]?.args).toMatchObject({ cursor: "cursor-2" })
	})

	test("after a Reload a browser filter reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(loaded(page([session("a")])), Message.ClickedReload()).model
		const filtered = routeChanged(reloaded, { search: { browser: "Safari" } }, context)
		expect(names(filtered.commands)).toContain(FetchFirstPage.name)
		expect(names(filtered.commands)).not.toContain("ResolveReplaysWindow")
		const moved = routeChanged(filtered.model, { search: { browser: "Safari", timePreset: "1h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveReplaysWindow", "Refresh"]])
	})

	test("a Reload under the same key drops the page 2 already in flight: it is appended once", () => {
		const model = loaded(page([session("a")], "cursor-1"))
		const first = pageUpdate(model, Message.ReachedListEnd())
		const answer = (generation: number) =>
			Message.CompletedFetchNextPage({ key: model.pagination.key ?? "", generation, cursor: "cursor-1", result: Result.succeed(page([session("b")])) })
		const reloaded = pageUpdate(first.model, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Refresh" })).model
		const late = pageUpdate(reloaded, answer(first.model.pagination.generation)).model
		const refreshed = Message.CompletedFetchFirstPage({ key: late.firstPage.key ?? "", result: Result.succeed(page([session("a")], "cursor-1")) })
		const again = pageUpdate(pageUpdate(late, refreshed).model, Message.ReachedListEnd())
		expect(names(again.commands)).toEqual([FetchNextPage.name])
		const appended = pageUpdate(again.model, answer(again.model.pagination.generation)).model
		expect(allRows(pageUpdate(appended, answer(again.model.pagination.generation)).model).map((row) => row.sessionId)).toEqual(["a", "b"])
	})

	test("the errors chip and a sidebar option navigate with the new search", () => {
		const model = loaded(page([session("a")]))
		expect(pageUpdate(model, Message.ToggledErrorsOnly()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/replays?hasErrors=true", isReplace: false }),
		)
		expect(pageUpdate(model, Message.ToggledFacetOption({ facet: "browser", name: "Safari" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/replays?browser=Safari", isReplace: false }),
		)
		const ticked = routeChanged(model, { search: { browser: "Safari" } }, context).model
		expect(pageUpdate(ticked, Message.ToggledFacetOption({ facet: "browser", name: "Safari" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/replays", isReplace: false }),
		)
	})

	test("a groupId link scopes the list and the facets to that group, and its banner clears it", () => {
		const groupId = "org_acme_1"
		const resolved = pageUpdate(
			init({ search: { groupId } }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(resolved.commands?.map(({ args }) => args)).toEqual([
			expect.objectContaining({ search: { groupId } }),
			expect.objectContaining({ search: { groupId } }),
		])
		expect(filterInputs({ groupId }, window).groupId).toBe(groupId)
		const model = loaded(page([session("a")]), { groupId })
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(VirtualizeList, rowsWindow(1)),
			expectView(text("Sessions from group")).toExist(),
			expectView(label("Clear group filter")).toExist(),
		)
		expect(pageUpdate(model, Message.ClickedClearGroupId()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/replays", isReplace: false }),
		)
	})

	test("a row opens its replay with the start time hint", () => {
		const model = loaded(page([session("srep_1")]))
		expect(
			pageUpdate(model, Message.ClickedSession({ sessionId: "srep_1", startTime: "2026-10-01 11:00:00" })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/replays/srep_1?t=2026-10-01+11%3A00%3A00", isReplace: false }),
		)
	})

	test("loaded sessions render in the virtual window", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(loaded(page([session("a", "Maria Garcia")])), rowsWindow(1)).model),
			Mount.resolve(VirtualizeList, rowsWindow(1)),
			expectView(text("Maria Garcia")).toExist(),
			expectView(text("2 pages")).toExist(),
		)
	})

	test("a page with more sessions mounts the end sentinel", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(loaded(page([session("a", "Maria Garcia")], "cursor-1")), rowsWindow(1)).model),
			Mount.resolve(VirtualizeList, rowsWindow(1)),
			Mount.resolve(WatchListEnd, Message.ReachedListEnd()),
			Command.resolve(
				FetchNextPage,
				Message.CompletedFetchNextPage({ key: "", generation: 0, cursor: "cursor-1", result: Result.succeed(page([])) }),
			),
			expectView(text("Maria Garcia")).toExist(),
		)
	})

	test("an empty org shows a skeleton until presence is known, never the 'No sessions found' copy", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadReplaysSignalPresence")
		scene(
			{ update: pageUpdate, view },
			given(loaded(page([]))),
			expectView(text("No sessions found")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded(page([])), "absent")),
			expectView(text("No sessions yet")).toExist(),
		)
	})

	test("a server repeating an earlier cursor stops paging after that page", () => {
		const model = loaded(page([session("a")], "cursor-1"))
		const asked = pageUpdate(model, Message.ReachedListEnd()).model
		const repeated = Message.CompletedFetchNextPage({
			key: model.pagination.key ?? "",
			generation: model.pagination.generation,
			cursor: "cursor-1",
			result: Result.succeed(page([session("b")], "cursor-1")),
		})
		const answered = pageUpdate(asked, repeated).model
		expect(allRows(answered).map((row) => row.sessionId)).toEqual(["a", "b"])
		expect(names(pageUpdate(answered, Message.ReachedListEnd()).commands)).toEqual([])
	})

	test("the end sentinel re-observes once a refreshed first page settles, like ReachEndSentinel", () => {
		const model = pageUpdate(loaded(page([session("a")], "cursor-1")), rowsWindow(1)).model
		const refreshing = pageUpdate(model, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Refresh" })).model
		const settled = pageUpdate(
			refreshing,
			Message.CompletedFetchFirstPage({ key: refreshing.firstPage.key ?? "", result: Result.succeed(page([session("a")], "cursor-1")) }),
		).model
		const keys: Array<unknown> = []
		const recordKey = tap<Model, Message>((simulation) => {
			keys.push(Option.getOrUndefined(find(simulation.html, "[data-replays-list-end]"))?.key)
		})
		// While refreshing, the visible sentinel's report is dropped: no page 2.
		scene(
			{ update: pageUpdate, view },
			given(refreshing),
			Mount.resolve(VirtualizeList, rowsWindow(1)),
			recordKey,
			Mount.resolve(WatchListEnd, Message.ReachedListEnd()),
			Command.expectNone(),
		)
		// Settled, a fresh observer reports the still-visible sentinel and page 2 is asked for.
		scene(
			{ update: pageUpdate, view },
			given(settled),
			Mount.resolve(VirtualizeList, rowsWindow(1)),
			recordKey,
			Mount.resolve(WatchListEnd, Message.ReachedListEnd()),
			Command.resolve(
				FetchNextPage,
				Message.CompletedFetchNextPage({ key: "", generation: 0, cursor: "cursor-1", result: Result.succeed(page([])) }),
			),
		)
		expect(keys).toHaveLength(2)
		expect(keys[0]).toBeDefined()
		expect(keys[0]).not.toEqual(keys[1])
	})
})
