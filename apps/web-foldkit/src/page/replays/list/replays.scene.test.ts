import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { Command, expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import type { SessionRow } from "../kit/session-row"
import {
	FetchFacets,
	FetchFirstPage,
	FetchNextPage,
	LoadSignalPresence,
	MountEmptyState,
	VirtualizeList,
	WatchListEnd,
} from "./command"
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

describe("replays list", () => {
	test("entry resolves the window, then asks for the first page and the facets", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("ResolveReplaysWindow")
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual([FetchFirstPage.name, FetchFacets.name])
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
				Message.CompletedFetchNextPage({ key: "", result: Result.succeed(page([])) }),
			),
			expectView(text("Maria Garcia")).toExist(),
		)
	})

	test("an empty org asks for signal presence once the empty state painted, then shows setup", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(page([]))),
			Mount.resolve(MountEmptyState, Message.PaintedEmptyState()),
			Command.resolve(
				LoadSignalPresence,
				Message.CompletedLoadSignalPresence({
					result: Result.succeed({ sessions: { status: "absent", lastSeenMs: null } }),
				}),
			),
			expectView(text("No sessions yet")).toExist(),
		)
	})
})
