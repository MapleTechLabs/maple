import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "../../charts/theme-colors"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Breakdowns, Model, Summary } from "./model"
import { init, panelOf, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const breakdowns: Breakdowns = {
	referrerHosts: [
		{ name: "www.google.com", count: 63 },
		{ name: "news.ycombinator.com", count: 9 },
	],
	countries: [{ name: "US", count: 70 }],
	deviceTypes: [{ name: "desktop", count: 109 }],
	browsers: [{ name: "Chrome", count: 120 }],
	operatingSystems: [],
	languages: [],
	utmSources: [],
	utmMediums: [],
	utmCampaigns: [],
	entryPaths: [{ name: "/", count: 40 }],
	exitPaths: [],
	hosts: [{ name: "shop.acme.test", count: 181 }],
}

const windowed = (search = {}): Model =>
	pageUpdate(init({ search }, context).model, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }))
		.model

const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const summary: Summary = {
	visitors: 181,
	sessions: 181,
	newSessions: 101,
	bouncedSessions: 31,
	identifiedSessions: 181,
	avgDurationMs: 262_000,
	botSessions: 0,
	botShare: null,
	coverage: 1,
	bounceRate: 0.17,
}

const settled = (model: Model, slot: "breakdowns" | "pages" | "events" | "summary", value: unknown): Model =>
	pageUpdate(model, Message.CompletedFetch({ slot, key: model[slot].key ?? "", result: Result.succeed(value) })).model

describe("web analytics", () => {
	test("the resolved window asks for the page's reads, the overview's and the live count", () => {
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		const sent = names(resolved.commands)
		expect(sent).toContain("FetchWebAnalyticsBreakdowns")
		expect(sent).toContain("FetchWebAnalyticsLive")
		expect(sent).toContain("FetchWebAnalyticsSummary")
		expect(sent).not.toContain("FetchWebAnalyticsAiCrawlers")
	})

	test("an events answer ahead of the breakdowns lands after them, as legacy's does", () => {
		const resolved = windowed()
		const sent = names(
			pageUpdate(
				init({ search: {} }, context).model,
				Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
			).commands,
		)
		expect(sent.indexOf("FetchWebAnalyticsBreakdowns")).toBeLessThan(
			sent.indexOf("FetchWebAnalyticsEvents"),
		)
		const early = settled(resolved, "events", [{ name: "add_to_cart", events: 12, sessions: 4 }])
		expect(early.events.data._tag).toBe("Loading")
		const both = settled(early, "breakdowns", breakdowns)
		expect(both.events.data._tag).toBe("Success")
		expect(both.heldEvents).toBeNull()
	})

	test("the AI tab asks for referrals and crawlers instead of the overview series", () => {
		const resolved = pageUpdate(
			init({ search: { tab: "ai" } }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		const sent = names(resolved.commands)
		expect(sent).toContain("FetchWebAnalyticsAiCrawlers")
		expect(sent).not.toContain("FetchWebAnalyticsTimeseries")
	})

	test("a failed AI read shows its failure instead of an empty panel", () => {
		const resolved = pageUpdate(
			init({ search: { tab: "ai" } }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		).model
		const failed = pageUpdate(
			resolved,
			Message.CompletedFetch({
				slot: "aiCrawlers",
				key: resolved.aiCrawlers.key ?? "",
				result: Result.fail(toLoadFailure("crawler store down")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			resolveTheme,
			expectView(text("Couldn't load AI crawlers")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetryAiCrawlers()).commands)).toEqual([
			"FetchWebAnalyticsAiCrawlers",
		])
	})

	test("a breakdown row toggles its filter through the URL", () => {
		const model = settled(windowed(), "breakdowns", breakdowns)
		expect(pageUpdate(model, Message.ToggledFilter({ key: "country", value: "US" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/analytics?country=US", isReplace: false }),
		)
		const filtered = routeChanged(model, { search: { country: "US" } }, context).model
		expect(pageUpdate(filtered, Message.ToggledFilter({ key: "country", value: "US" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/analytics", isReplace: false }),
		)
	})

	test("clearing filters keeps the window and the tab", () => {
		const model = windowed({ tab: "ai", country: "US", timePreset: "24h" })
		expect(pageUpdate(model, Message.ClickedClearFilters()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/analytics?timePreset=24h&tab=ai", isReplace: false }),
		)
	})

	test("after a Reload a country filter reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(windowed(), Message.ClickedReload()).model
		const filtered = routeChanged(reloaded, { search: { country: "US" } }, context)
		expect(names(filtered.commands)).not.toContain("ResolveAnalyticsWindow")
		expect(filtered.commands?.[0]?.args).toMatchObject({ input: { startTime: window.startTime, country: "US" } })
		const moved = routeChanged(filtered.model, { search: { country: "US", timePreset: "1h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveAnalyticsWindow", "Refresh"]])
	})

	test("a card sorts by sessions when its page views had not arrived as it mounted", () => {
		const early = settled(windowed(), "breakdowns", breakdowns)
		expect(panelOf(early, "content").sortKey).toBe("count")
		const late = settled(early, "pages", [{ host: "shop.acme.test", pagePath: "/", pageViews: 210, sessions: 127 }])
		expect(panelOf(late, "content").sortKey).toBe("count")
	})

	test("the header reload leaves the page-level breakdowns alone", () => {
		const model = settled(settled(windowed(), "breakdowns", breakdowns), "summary", summary)
		const reloaded = pageUpdate(
			pageUpdate(model, Message.ClickedReload()).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Refresh" }),
		)
		const sent = names(reloaded.commands)
		expect(sent).toContain("FetchWebAnalyticsSummary")
		expect(sent).not.toContain("FetchWebAnalyticsBreakdowns")
	})

	test("loaded breakdowns render their cards and the active filter chips", () => {
		scene(
			{ update: pageUpdate, view },
			given(settled(windowed({ country: "US" }), "breakdowns", breakdowns)),
			resolveTheme,
			expectView(text("www.google.com")).toExist(),
			expectView(text("Clear all")).toExist(),
		)
	})

	test("an org that never sent sessions gets the setup state", () => {
		const model = pageUpdate(
			windowed(),
			Message.CompletedLoadSignalPresence({
				result: Result.succeed({ sessions: { status: "absent", lastSeenMs: null } }),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("No visits yet")).toExist(),
			expectView(text("Set up web analytics")).toExist(),
		)
	})
})
