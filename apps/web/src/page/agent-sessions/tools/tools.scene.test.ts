import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import type { TotalsResult } from "../tools-kit/model"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const measures = { calls: 3, sessions: 2, errors: 1, p50: 1, p90: 2, p95: 3 }
const totals: TotalsResult = {
	current: measures,
	previous: undefined,
	allSessions: 8,
	firstSeen: 0,
	lastSeen: 0,
	description: undefined,
}

const windowed = (search: Model["search"] = {}) =>
	pageUpdate(
		init({ search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	)

describe("agent tools", () => {
	test("an unfiltered window reads totals and breakdowns once: the tab counts share them", () => {
		const resolved = windowed()
		expect(names(resolved.commands).filter((name) => name === "FetchAgentToolsTotals")).toHaveLength(1)
		expect(resolved.model.tabTotals.key).toBe(resolved.model.totals.key)
		const answered = pageUpdate(
			resolved.model,
			Message.CompletedFetchTotals({
				key: resolved.model.totals.key ?? "",
				result: Result.succeed(totals),
			}),
		)
		expect(AsyncData.hasData(answered.model.tabTotals.data)).toBe(true)
	})

	test("a filtered window reads the bare window for the tabs, and dropping the filter reuses it", () => {
		const filtered = windowed({ tool: "Bash" })
		expect(names(filtered.commands).filter((name) => name === "FetchAgentToolsTotals")).toHaveLength(2)
		const answered = pageUpdate(
			filtered.model,
			Message.CompletedFetchTabTotals({
				key: filtered.model.tabTotals.key ?? "",
				result: Result.succeed(totals),
			}),
		)
		const cleared = pageUpdate(answered.model, Message.ClickedClearScope())
		expect(cleared.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/agent-sessions/tools", isReplace: false }),
		)
	})

	test("a stale totals answer is dropped", () => {
		const resolved = windowed().model
		const late = pageUpdate(
			resolved,
			Message.CompletedFetchTotals({ key: "old", result: Result.succeed(totals) }),
		)
		expect(AsyncData.isLoading(late.model.totals.data)).toBe(true)
	})

	test("tiles, failing chip and table sort write the URL or the sort", () => {
		const model = windowed().model
		expect(pageUpdate(model, Message.ClickedMetric({ metric: "error_rate" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/agent-sessions/tools?metric=error_rate",
				isReplace: false,
			}),
		)
		expect(pageUpdate(model, Message.ClickedMetric({ metric: "calls" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/agent-sessions/tools", isReplace: false }),
		)
		expect(pageUpdate(model, Message.ToggledFailingOnly()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/agent-sessions/tools?failing=true",
				isReplace: false,
			}),
		)
		const sorted = pageUpdate(model, Message.ClickedTableSort({ key: "key" }))
		expect(sorted.model.tableSort).toEqual({ key: "key", dir: "asc" })
		expect(pageUpdate(sorted.model, Message.ClickedTableSort({ key: "key" })).model.tableSort).toEqual({
			key: "key",
			dir: "desc",
		})
	})

	test("Reload re-resolves the window unsnapped and spins", () => {
		const reloaded = pageUpdate(windowed().model, Message.ClickedReload())
		expect(names(reloaded.commands)).toEqual(
			expect.arrayContaining(["ResolveAgentToolsWindow", "CompleteAgentToolsReloadSpin"]),
		)
		expect(reloaded.model.isReloading).toBe(true)
	})

	test("after Reload, a metric tile's URL change re-reads nothing; a new filter reads only its own keys", () => {
		const reloaded = pageUpdate(windowed().model, Message.ClickedReload()).model
		const resolved = pageUpdate(
			reloaded,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Refresh" }),
		).model
		expect(names(routeChanged(resolved, { search: { metric: "error_rate" } }, context).commands)).toEqual(
			[],
		)
		const filtered = names(routeChanged(resolved, { search: { tool: "Bash" } }, context).commands)
		expect(filtered.filter((name) => name === "FetchAgentToolsTotals")).toHaveLength(1)
		expect(filtered).toEqual(
			expect.arrayContaining(["FetchAgentToolsSeries", "FetchAgentToolsBreakdowns"]),
		)
		expect(filtered).not.toContain("FetchAgentToolsFacets")
	})
})
