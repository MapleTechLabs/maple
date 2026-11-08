import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import * as Chart from "@maple/views/charts/chart"
import { MountChart } from "@maple/views/charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model, SearchStatus } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const site = (overrides: Partial<SearchStatus["sites"][number]> = {}): SearchStatus["sites"][number] => ({
	siteUrl: "sc-domain:acme.dev",
	enabled: true,
	watermarkDate: "2026-09-29",
	lastSyncedAt: NOW,
	lastError: null,
	...overrides,
})

const status = (overrides: Partial<SearchStatus> = {}): SearchStatus => ({
	configured: true,
	connected: true,
	revoked: false,
	sites: [site()],
	...overrides,
})

const windowed = (search = {}) =>
	pageUpdate(
		init({ search: { tab: "search", ...search } }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	)

const answer = (model: Model, slot: SlotOf, value: unknown) =>
	pageUpdate(
		model,
		Message.CompletedFetch({ slot, key: model[slot].key ?? "", result: Result.succeed(value) }),
	)

type SlotOf =
	| "searchStatus"
	| "searchOverview"
	| "searchTimeseries"
	| "searchQueries"
	| "searchPages"
	| "searchLanding"

const metrics = { clicks: 120, impressions: 4000, ctr: 0.03, position: 7.4 }

const populated = (): Model => {
	const connected = answer(windowed().model, "searchStatus", status()).model
	return Arr.reduce(
		[
			["searchOverview", { ...metrics, previous: { ...metrics, clicks: 100, position: 8.1 } }],
			["searchTimeseries", [{ date: "2026-09-28", ...metrics }]],
			["searchQueries", [{ query: "opentelemetry tracing", ...metrics }]],
			["searchPages", [{ page: "https://acme.dev/docs/tracing", ...metrics }]],
			[
				"searchLanding",
				[
					{
						page: "https://acme.dev/docs/tracing",
						host: "acme.dev",
						path: "/docs/tracing",
						...metrics,
						sessions: 96,
						bounceRate: 0.41,
						conversions: null,
					},
				],
			],
		] as const,
		connected,
		(model, [slot, value]) => answer(model, slot, value).model,
	)
}

describe("web analytics: Search tab", () => {
	test("asks for the status first, then the reads once a property has imported", () => {
		const resolved = windowed()
		const sent = names(resolved.commands)
		expect(sent).toContain("FetchSearchConsoleStatus")
		expect(sent).not.toContain("FetchSearchConsoleOverview")
		const after = names(answer(resolved.model, "searchStatus", status()).commands)
		expect(after).toEqual(
			expect.arrayContaining([
				"FetchSearchConsoleOverview",
				"FetchSearchConsoleTimeseries",
				"FetchSearchConsoleTopQueries",
				"FetchSearchConsoleTopPages",
				"FetchSearchConsoleLandingPages",
			]),
		)
	})

	test("an org without Search Console gets the connect on-ramp, not demo data", () => {
		const model = answer(windowed().model, "searchStatus", status({ connected: false, sites: [] }))
		expect(names(model.commands)).not.toContain("FetchSearchConsoleOverview")
		scene(
			{ update: pageUpdate, view },
			given(model.model),
			resolveTheme,
			expectView(text("No search data yet")).toExist(),
			expectView(text("Connect Search Console")).toExist(),
		)
	})

	test("a revoked grant asks to reconnect", () => {
		scene(
			{ update: pageUpdate, view },
			given(answer(windowed().model, "searchStatus", status({ revoked: true })).model),
			resolveTheme,
			expectView(text("Reconnect Google Search Console")).toExist(),
		)
	})

	test("a property still on its first import says so and reads nothing", () => {
		const model = answer(
			windowed().model,
			"searchStatus",
			status({ sites: [site({ watermarkDate: null })] }),
		)
		expect(names(model.commands)).not.toContain("FetchSearchConsoleTopQueries")
		scene(
			{ update: pageUpdate, view },
			given(model.model),
			resolveTheme,
			expectView(text("Importing from Search Console")).toExist(),
		)
	})

	test("a first import that failed shows Google's error", () => {
		const model = answer(
			windowed().model,
			"searchStatus",
			status({
				sites: [site({ watermarkDate: null, lastError: "User does not have sufficient permission" })],
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(model.model),
			resolveTheme,
			expectView(text("Couldn't import from Search Console")).toExist(),
			expectView(text("User does not have sufficient permission")).toExist(),
		)
	})

	test("populated: KPIs, the lag note, queries, pages and landing pages with sessions", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated()),
			resolveTheme,
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			expectView(text("Search Console data arrives 2 to 3 days late")).toExist(),
			expectView(text("Avg position")).toExist(),
			expectView(text("opentelemetry tracing")).toExist(),
			expectView(text("41%")).toExist(),
			expectView(text("96")).toExist(),
		)
	})

	test("a failed read offers a retry that asks again for it alone", () => {
		const connected = answer(windowed().model, "searchStatus", status()).model
		const failed = pageUpdate(
			connected,
			Message.CompletedFetch({
				slot: "searchQueries",
				key: connected.searchQueries.key ?? "",
				result: Result.fail(toLoadFailure("warehouse down")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			resolveTheme,
			expectView(text("Couldn't load search queries")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetrySearch()).commands)).toContain(
			"FetchSearchConsoleTopQueries",
		)
	})

	test("picking another property moves the URL", () => {
		const model = answer(
			windowed().model,
			"searchStatus",
			status({ sites: [site(), site({ siteUrl: "https://blog.acme.dev/" })] }),
		).model
		expect(
			pageUpdate(model, Message.PickedSearchSite({ siteUrl: "https://blog.acme.dev/" })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/analytics?tab=search&site=https%3A%2F%2Fblog.acme.dev%2F",
				isReplace: false,
			}),
		)
	})

	test("sorting by position starts with the best (lowest) one", () => {
		const sorted = pageUpdate(
			populated(),
			Message.ClickedSearchSort({ table: "queries", key: "position" }),
		)
		expect(sorted.model.searchSorts["queries"]).toEqual({ key: "position", dir: "asc" })
	})
})
