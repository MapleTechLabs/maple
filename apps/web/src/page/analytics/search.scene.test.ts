import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import {
	all,
	click,
	Command,
	expect as expectView,
	first,
	given,
	Mount,
	role,
	type SceneSimulation,
	scene,
	text,
	textContent,
	withViewInputs,
} from "foldkit/scene"
import * as Chart from "@maple/views/charts/chart"
import { MountChart } from "@maple/views/charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { FetchEvents, FetchSearchQueries, FetchSearchTimeseries } from "./command"
import { Message, type SlotName } from "./message"
import type { SearchConsoleIntegrationStatus } from "@maple/domain/http"
import type { Model } from "./model"
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

type StatusWire = typeof SearchConsoleIntegrationStatus.Encoded
type SiteWire = StatusWire["sites"][number]

const site = (overrides: Partial<SiteWire> = {}): SiteWire => ({
	id: "0190f2b3-0000-7000-8000-000000000001",
	siteUrl: "sc-domain:acme.dev",
	permissionLevel: "siteOwner",
	enabled: true,
	watermarkDate: "2026-09-29",
	backfillDate: "2026-06-01",
	lastSyncedAt: NOW,
	lastError: null,
	...overrides,
})

const status = (overrides: Partial<StatusWire> = {}): StatusWire => ({
	configured: true,
	connected: true,
	accountEmail: "owner@acme.dev",
	connectedByUserId: null,
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

type SlotOf = SlotName

const breakdowns = {
	referrerHosts: [{ name: "www.google.com", count: 63 }],
	countries: [],
	deviceTypes: [],
	browsers: [],
	operatingSystems: [],
	languages: [],
	utmSources: [],
	utmMediums: [],
	utmCampaigns: [],
	entryPaths: [],
	exitPaths: [],
	hosts: [],
}

const metrics = { clicks: 120, impressions: 4000, ctr: 0.03, position: 7.4 }

const populated = (statusWire: StatusWire = status()): Model => {
	const connected = answer(windowed().model, "searchStatus", statusWire).model
	return Arr.reduce(
		[
			["searchOverview", { ...metrics, previous: { ...metrics, clicks: 100, position: 8.1 } }],
			["searchTimeseries", [{ date: "2026-09-28", ...metrics }]],
			["searchQueries", [{ query: "opentelemetry tracing", ...metrics }]],
			[
				"searchPages",
				[
					{
						page: "https://acme.dev/docs/tracing",
						host: "acme.dev",
						path: "/docs/tracing",
						...metrics,
					},
				],
			],
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
			// Google's day at NOW is Oct 1 and the watermark Sep 29: complete through Sep 29.
			expectView(
				text("Data through Sep 29. Google's latest days are preliminary and can still change"),
			).toExist(),
			// Clicks rose from 100 to 120 against a fully imported previous period.
			expectView(text(/20(\.0)?%/)).toExist(),
			expectView(text(/still importing/)).not.toExist(),
			expectView(text("Entry sessions")).toExist(),
			expectView(text("Avg position")).toExist(),
			expectView(text("opentelemetry tracing")).toExist(),
			expectView(text("41%")).toExist(),
			expectView(text("96")).toExist(),
		)
	})

	test("the reads end at the last complete day, so today's partial data never counts", () => {
		const today = status({ sites: [site({ watermarkDate: "2026-10-01" })] })
		const connected = answer(windowed().model, "searchStatus", today)
		const overview = Arr.findFirst(
			connected.commands ?? [],
			(command) => command.name === "FetchSearchConsoleOverview",
		)
		expect(overview._tag === "Some" ? overview.value.args : undefined).toMatchObject({
			input: { completeThrough: "2026-09-30" },
		})
	})

	test("no impressions in the window shows no change, not a better position", () => {
		const connected = answer(windowed().model, "searchStatus", status()).model
		const empty = { clicks: 0, impressions: 0, ctr: 0, position: 0 }
		const model = answer(connected, "searchOverview", {
			...empty,
			previous: { clicks: 10, impressions: 500, ctr: 0.02, position: 6.2 },
		}).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("Avg position")).toExist(),
			expectView(text(/100(\.0)?%/)).not.toExist(),
		)
	})

	test("no impressions reads CTR as empty, like position, not 0%", () => {
		const connected = answer(windowed().model, "searchStatus", status()).model
		const model = answer(connected, "searchOverview", {
			clicks: 0,
			impressions: 0,
			ctr: 0,
			position: 0,
			previous: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
		}).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("CTR")).toExist(),
			expectView(text("0%")).not.toExist(),
		)
	})

	test("a comparison period before the imported history shows no change and says so", () => {
		// The window starts Sep 25; its previous period starts Sep 20, before the Sep 22 frontier.
		const model = populated(status({ sites: [site({ backfillDate: "2026-09-22" })] }))
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			expectView(text("History before Sep 22 is still importing")).toExist(),
			expectView(text(/20(\.0)?%/)).not.toExist(),
			expectView(text("opentelemetry tracing")).toExist(),
		)
	})

	test("a failed status asks for nothing more, and Retry asks for it again", () => {
		const resolved = windowed().model
		const failed = pageUpdate(
			resolved,
			Message.CompletedFetch({
				slot: "searchStatus",
				key: resolved.searchStatus.key ?? "",
				result: Result.fail(toLoadFailure("api down")),
			}),
		)
		expect(names(failed.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			resolveTheme,
			expectView(text("Couldn't load Search Console")).toExist(),
		)
		expect(names(pageUpdate(failed.model, Message.ClickedRetrySearch()).commands)).toEqual([
			"FetchSearchConsoleStatus",
		])
	})

	test("while the first import runs, the status poll re-reads it and the tab moves on", () => {
		const importing = answer(
			windowed().model,
			"searchStatus",
			status({ sites: [site({ watermarkDate: null })] }),
		).model
		const ticked = pageUpdate(importing, Message.TickedSearchImportPoll())
		expect(names(ticked.commands)).toEqual(["FetchSearchConsoleStatus"])
		const imported = answer(ticked.model, "searchStatus", status())
		expect(names(imported.commands)).toContain("FetchSearchConsoleOverview")
	})

	test("the Search tab's rail holds only the event filter", () => {
		const withBreakdowns = answer(populated(), "breakdowns", breakdowns).model
		const model = answer(withBreakdowns, "events", [{ name: "signup", events: 9, sessions: 7 }]).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			expectView(text("signup")).toExist(),
			expectView(text("www.google.com")).not.toExist(),
			expectView(text("Humans")).not.toExist(),
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

	type Commands = SceneSimulation<unknown, unknown, unknown>["commands"]

	/** A scene step that checks the commands the last interaction left pending. */
	const sent =
		(check: (commands: Commands) => void) =>
		<M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
			check(simulation.commands)
			return simulation
		}

	/** Answers the pending fetch the last step sent, so the scene ends with nothing in flight. */
	const settle =
		(
			resolve: (
				message: Message,
			) => <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>) => SceneSimulation<M, Msg, Out>,
			slot: SlotOf,
		) =>
		<M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
			const key = simulation.commands[0]?.args?.["key"]
			const message = Message.CompletedFetch({
				slot,
				key: typeof key === "string" ? key : "",
				result: Result.succeed([]),
			})
			return resolve(message)(simulation)
		}

	const failSlot = (model: Model, slot: SlotOf, message: string) =>
		pageUpdate(
			model,
			Message.CompletedFetch({
				slot,
				key: model[slot].key ?? "",
				result: Result.fail(toLoadFailure(message)),
			}),
		).model

	test("a failed trend read shows its error, not an empty window, and Retry asks for it again", () => {
		const connected = answer(windowed().model, "searchStatus", status()).model
		const model = failSlot(connected, "searchTimeseries", "warehouse down")
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("Couldn't load the search trend")).toExist(),
			expectView(text("No search data in this window")).not.toExist(),
			click(role("button", { name: "Try again" })),
			sent((commands) => expect(names(commands)).toEqual(["FetchSearchConsoleTimeseries"])),
			settle((message) => Command.resolve(FetchSearchTimeseries, message), "searchTimeseries"),
		)
	})

	test("a failed events read shows the rail's error with a retry, not an empty rail", () => {
		// The events answer waits for the breakdowns (`delivered`), so they land first.
		const model = failSlot(
			answer(populated(), "breakdowns", breakdowns).model,
			"events",
			"warehouse down",
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			expectView(text("Something went wrong")).toExist(),
			click(role("button", { name: "Try again" })),
			sent((commands) => expect(names(commands)).toEqual(["FetchWebAnalyticsEvents"])),
			settle((message) => Command.resolve(FetchEvents, message), "events"),
		)
	})

	test("sorting a table by impressions asks the read for the top rows by impressions", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated()),
			resolveTheme,
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			click(first(all.role("button", { name: "Impressions" }))),
			sent((commands) => {
				expect(names(commands)).toEqual(["FetchSearchConsoleTopQueries"])
				expect(commands[0]?.args).toMatchObject({ input: { sortBy: "impressions", sortDir: "desc" } })
			}),
			settle((message) => Command.resolve(FetchSearchQueries, message), "searchQueries"),
		)
	})

	test("a table renders the read's order, and an older sort's answer is dropped", () => {
		const byClicks = populated()
		const sorted = pageUpdate(byClicks, Message.ClickedSearchSort({ table: "pages", key: "impressions" }))
		const staleKey = byClicks.searchPages.key ?? ""
		const late = pageUpdate(
			sorted.model,
			Message.CompletedFetch({ slot: "searchPages", key: staleKey, result: Result.succeed([]) }),
		).model
		expect(late.searchPages.key).toBe(sorted.model.searchPages.key)
		const row = (path: string, impressions: number) => ({
			page: `https://acme.dev${path}`,
			host: "acme.dev",
			path,
			clicks: 1,
			impressions,
			ctr: 0.01,
			position: 3,
		})
		// Served out of the client's order on purpose: the table must keep the read's order.
		const answered = answer(late, "searchPages", [row("/fewer", 100), row("/more", 900)]).model
		scene(
			{ update: pageUpdate, view },
			given(answered),
			resolveTheme,
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			<M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
				expect(textContent(simulation.html)).toMatch(/\/fewer.*\/more/su)
				return simulation
			},
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
