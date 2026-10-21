import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	label,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { MountFilterRail, MountRowClicks, MountTable, openedRowUrl, VirtualizeSessions } from "./command"
import { pageRows, rankedOf } from "./derive"
import { Message } from "./message"
import type { Facets, Model, SessionRow } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

/** The virtualizer's window over one 53px row at the top of the page scroller. */
const ONE_ROW = { items: [{ index: 0, start: 0, end: 53 }], totalSize: 53, scrollMargin: 0 }

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const session = (sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow => ({
	sessionId,
	vendorId: "effect_ai",
	vendorVersion: "",
	traceCount: 1,
	spanCount: 4,
	errorSpanCount: 0,
	toolErrorCount: 0,
	turnErrorCount: 0,
	serviceNames: ["support-agent"],
	models: ["gpt-5-mini"],
	agentNames: ["support-triage"],
	firstAgentName: "support-triage",
	llmCalls: 2,
	toolCalls: 1,
	totalTokens: 1000,
	inputTokens: 800,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 200,
	reasoningTokens: 0,
	cost: 0.004,
	startTime: "2026-10-01 07:00:00.000000000",
	endTime: "2026-10-01 07:01:00.000000000",
	durationMs: 60_000,
	...overrides,
})

const facets: Facets = {
	vendors: [{ name: "effect_ai", count: 1 }],
	services: [{ name: "support-agent", count: 1 }],
	environments: [],
	models: [{ name: "gpt-5-mini", count: 1 }],
	agents: [{ name: "support-triage", count: 1 }],
	tools: [],
}

/** Entered with the rail mounted (it renders with the page), then windowed. */
const windowed = (search: Model["search"] = {}): Model =>
	pageUpdate(
		pageUpdate(init({ search }, context).model, Message.MountedFilterRail()).model,
		Message.CompletedResolveWindow({ window, tabWindow: window, nowMs: NOW, mode: "Load" }),
	).model

const loaded = (rows: ReadonlyArray<SessionRow>, search: Model["search"] = {}): Model => {
	const base = windowed(search)
	const steps: ReadonlyArray<Message> = [
		Message.CompletedFetchFirstPage({
			key: base.firstPage.key ?? "",
			result: Result.succeed({ data: rows, ranked: rows.length }),
		}),
		Message.CompletedFetchFacets({ key: base.facets.key ?? "", result: Result.succeed(facets) }),
	]
	return steps.reduce((model, message) => pageUpdate(model, message).model, base)
}

/** Loaded, painted, its details already asked for. */
const painted = (rows: ReadonlyArray<SessionRow>): Model =>
	pageUpdate(loaded(rows), Message.PaintedTable()).model

const withPresence = (model: Model, status: "present" | "absent"): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({ traces: { status, lastSeenMs: null } }),
		}),
	).model

describe("agent sessions list", () => {
	test("the rail detects its empty model set as it mounts, then the week's reads go out under their keys", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining([
				"LoadAgentSessionsSignalPresence",
				"ResolveAgentSessionsWindow",
				"ReadRememberedFilterSections",
			]),
		)
		const mounted = pageUpdate(entered.model, Message.MountedFilterRail())
		expect(names(mounted.commands)).toEqual(["DetectAgentSessionsModels"])
		expect(names(pageUpdate(mounted.model, Message.MountedFilterRail()).commands)).toEqual([])
		const resolved = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, tabWindow: window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(
			expect.arrayContaining([
				"FetchAgentSessionsFirstPage",
				"FetchAgentSessionsFacets",
				"FetchAgentSessionsDistributions",
				"FetchAgentSessionsTabSessions",
				"FetchAgentSessionsTabTools",
			]),
		)
	})

	test("a first page answered for a superseded filter is dropped", () => {
		const first = windowed()
		const filtered = pageUpdate(first, Message.ToggledErrorsOnly())
		expect(filtered.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/agent-sessions?hasErrors=true", isReplace: false }),
		)
		const stale = pageUpdate(
			{ ...first, firstPage: { ...first.firstPage, key: "newer" } },
			Message.CompletedFetchFirstPage({
				key: first.firstPage.key ?? "",
				result: Result.succeed({ data: [session("old")], ranked: 1 }),
			}),
		)
		expect(stale.model.firstPage.key).toBe("newer")
	})

	test("the painted rows ask for their details once, and the answer merges in", () => {
		const painted = pageUpdate(loaded([session("conv_a")]), Message.PaintedTable())
		expect(names(painted.commands)).toContain("FetchAgentSessionDetails")
		const again = pageUpdate(painted.model, Message.ReachedListEnd())
		expect(names(again.commands)).not.toContain("FetchAgentSessionDetails")
		const merged = pageUpdate(
			painted.model,
			Message.CompletedFetchDetails({
				detailsKey: painted.model.details.detailsKey,
				sessionIds: ["conv_a"],
				result: Result.succeed([
					{
						sessionId: "conv_a",
						spanCount: 9,
						errorSpanCount: 3,
						serviceNames: ["support-agent", "billing"],
						startTime: "2026-10-01 06:59:00.000000000",
						endTime: "2026-10-01 07:02:00.000000000",
						durationMs: 180_000,
					},
				]),
			}),
		)
		expect(merged.model.details.bySession["conv_a"]?.spanCount).toBe(9)
	})

	test("a full page pages on the ranked count, and a second reach while one is in flight waits", () => {
		const rows = Array.from({ length: 50 }, (_, index) => session(`conv_${index}`))
		const model = loaded(rows)
		const reached = pageUpdate(model, Message.ReachedListEnd())
		expect(names(reached.commands)).toEqual(["FetchAgentSessionsNextPage"])
		expect(reached.model.isFetchingNextPage).toBe(true)
		expect(names(pageUpdate(reached.model, Message.ReachedListEnd()).commands)).toEqual([])
	})

	test("a second answer for an offset already filled is dropped, not appended", () => {
		const rows = Array.from({ length: 50 }, (_, index) => session(`conv_${index}`))
		const reached = pageUpdate(loaded(rows), Message.ReachedListEnd()).model
		const key = reached.morePages.filterKey
		const more = Array.from({ length: 50 }, (_, index) => session(`more_${index}`))
		const answer = Message.CompletedFetchNextPage({ key, offset: 50, result: Result.succeed({ data: more, ranked: 50 }) })
		const once = pageUpdate(reached, answer).model
		const twice = pageUpdate(once, answer).model
		expect(pageRows(twice, key)).toHaveLength(100)
	})

	test("rows render and a column header sorts through the URL", () => {
		scene(
			{ update: pageUpdate, view },
			given(painted([session("conv_a")])),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			Mount.resolve(MountTable, Message.PaintedTable()),
			Mount.resolve(VirtualizeSessions, Message.ChangedListWindow({ window: ONE_ROW })),
			Mount.resolve(MountRowClicks, Message.ClickedSessionRow({ url: "/agent-sessions/conv_a" })),
			expectView(role("table", { name: "Agent sessions" })).toExist(),
			expectView(text("support-triage")).toExist(),
			click(role("button", { name: "Duration" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/agent-sessions?sortBy=durationMs&sortDir=desc",
					isReplace: false,
				}),
			),
		)
	})

	test("an agent ticked in the rail writes the agents filter", () => {
		scene(
			{ update: pageUpdate, view },
			given(painted([session("conv_a")])),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			Mount.resolve(MountTable, Message.PaintedTable()),
			Mount.resolve(VirtualizeSessions, Message.ChangedListWindow({ window: ONE_ROW })),
			Mount.resolve(MountRowClicks, Message.ClickedSessionRow({ url: "/agent-sessions/conv_a" })),
			click(role("checkbox", { name: "support-triage" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/agent-sessions?agents=%5B%22support-triage%22%5D",
					isReplace: false,
				}),
			),
		)
	})

	test("an empty org shows a skeleton until presence is known, never the 'No agent sessions found' copy", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadAgentSessionsSignalPresence")
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			expectView(text("No agent sessions found")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded([]), "absent")),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			expectView(text("No agent sessions yet")).toExist(),
			expectView(role("link", { name: "Setup guide" })).toHaveAttr(
				"href",
				"https://maple.dev/docs/agent-sessions/overview",
			),
		)
	})

	test("a range typed past its debounce commits, reversed bounds swapped", () => {
		const model = loaded([session("conv_a")])
		const typed = pageUpdate(model, Message.ChangedRangeDraft({ range: "cost", min: "0.5", max: "0.1" }))
		const committed = pageUpdate(
			typed.model,
			Message.ElapsedRangeDebounce({ range: "cost", version: typed.model.rangeDraftVersion }),
		)
		expect(committed.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/agent-sessions?costMin=0.1&costMax=0.5",
				isReplace: false,
			}),
		)
	})

	test("a short server page pages on the server's ranked count, not its row count", () => {
		expect(rankedOf({ data: [session("conv_a")], ranked: 50 })).toBe(50)
		expect(rankedOf({ data: [session("conv_a")] })).toBe(1)
	})

	test("a plain click outside a link opens the row's session; a modified click or one on a link does not", () => {
		const plain = {
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			isInsideLink: false,
			rowUrl: "/agent-sessions/conv_a",
		}
		expect(openedRowUrl(plain)).toEqual(Option.some("/agent-sessions/conv_a"))
		expect(openedRowUrl({ ...plain, metaKey: true })).toEqual(Option.none())
		expect(openedRowUrl({ ...plain, ctrlKey: true })).toEqual(Option.none())
		expect(openedRowUrl({ ...plain, button: 1 })).toEqual(Option.none())
		expect(openedRowUrl({ ...plain, isInsideLink: true })).toEqual(Option.none())
		expect(openedRowUrl({ ...plain, rowUrl: null })).toEqual(Option.none())
	})

	test("a row's click, the service pills included, opens its session through the URL", () => {
		scene(
			{ update: pageUpdate, view },
			given(painted([session("conv_a")])),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			Mount.resolve(MountTable, Message.PaintedTable()),
			Mount.resolve(VirtualizeSessions, Message.ChangedListWindow({ window: ONE_ROW })),
			Mount.resolve(MountRowClicks, Message.ClickedSessionRow({ url: "/agent-sessions/conv_a" })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ url: "/agent-sessions/conv_a", isReplace: false })),
		)
	})
})
