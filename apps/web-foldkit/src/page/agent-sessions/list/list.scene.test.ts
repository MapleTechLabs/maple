import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { LoadSignalPresence, MountEmptyState, MountTable } from "./command"
import { Message } from "./message"
import type { Facets, Model, SessionRow } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

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

const windowed = (search: Model["search"] = {}): Model =>
	pageUpdate(
		init({ search }, context).model,
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

describe("agent sessions list", () => {
	test("entry detects the rail's empty model set, then the week's reads go out under their keys", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toEqual([
			"ResolveAgentSessionsWindow",
			"DetectAgentSessionsModels",
			"ReadRememberedFilterSections",
		])
		const resolved = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, tabWindow: window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual([
			"FetchAgentSessionsFirstPage",
			"FetchAgentSessionsFacets",
			"FetchAgentSessionsDistributions",
			"FetchAgentSessionsTabSessions",
			"FetchAgentSessionsTabTools",
		])
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

	test("rows render and a column header sorts through the URL", () => {
		scene(
			{ update: pageUpdate, view },
			given(painted([session("conv_a")])),
			Mount.resolve(MountTable, Message.PaintedTable()),
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
			Mount.resolve(MountTable, Message.PaintedTable()),
			click(role("checkbox", { name: "support-triage" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/agent-sessions?agents=%5B%22support-triage%22%5D",
					isReplace: false,
				}),
			),
		)
	})

	test("an empty org asks for signal presence once the empty state painted, then shows setup", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			expectView(text("No agent sessions found")).toExist(),
			Mount.resolve(MountEmptyState, Message.PaintedEmptyState()),
			Command.resolve(
				LoadSignalPresence,
				Message.CompletedLoadSignalPresence({
					result: Result.succeed({ traces: { status: "absent", lastSeenMs: null } }),
				}),
			),
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
})
