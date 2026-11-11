import { OrgId } from "@maple/domain"
import {
	CostBreakdownResponse,
	CostFilters,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
} from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model, Search } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-12 00:00:00", endTime: "2026-11-10 14:30:00" }
const NOW = Date.UTC(2026, 10, 10, 14, 30)

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

type Sent = ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined
const names = (commands: Sent) => Arr.map(commands ?? [], ({ name }) => name)
/** What a read of the window carries; the grouping, order and limit only on the reads that take them. */
const ReadInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	filters: Schema.optionalKey(CostFilters),
	groupBy: Schema.optionalKey(Schema.String),
	sortBy: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Number),
})
const decodeArgs = Schema.decodeUnknownOption(Schema.Struct({ input: ReadInput }))

/** The input a named read was sent with. */
const inputOf = (commands: Sent, name: string): typeof ReadInput.Type | undefined =>
	Option.getOrUndefined(
		Option.flatMap(
			Arr.findFirst(commands ?? [], (command) => command.name === name),
			(command) => decodeArgs(command.args),
		),
	)?.input

type SourceWire = (typeof CostSourcesResponse.Encoded)["sources"][number]

const source = (over: Partial<SourceWire> = {}): SourceWire => ({
	id: "0190f2b3-0000-7000-8000-00000000c057",
	provider: "aws",
	accountId: "123456789012",
	status: "ok",
	watermarkDate: "2026-11-09",
	backfillDate: "2025-10-01",
	historyComplete: true,
	lastSyncedAt: NOW - 3_600_000,
	lastError: null,
	lastErrorReason: null,
	requestsThisMonth: 86,
	...over,
})

const sources = (list: ReadonlyArray<SourceWire>) => Schema.decodeSync(CostSourcesResponse)({ sources: list })
const totals = (over: Partial<typeof CostTotalsResponse.Encoded> = {}) =>
	Schema.decodeSync(CostTotalsResponse)({
		cost: 1200,
		previousCost: 1000,
		estimatedDays: 2,
		currency: "USD",
		currencies: ["USD"],
		days: 30,
		...over,
	})
const timeseries = Schema.decodeSync(CostTimeseriesResponse)({
	days: ["2026-11-08", "2026-11-09"],
	series: [
		{ key: "north-1", other: false, total: 900, points: [440, 460] },
		{ key: "", other: false, total: 300, points: [150, 150] },
	],
	estimatedFrom: "2026-11-09",
	currency: "USD",
})
const breakdown = Schema.decodeSync(CostBreakdownResponse)({
	currency: "USD",
	rows: [
		{ key: "north-1", cost: 900, previousCost: 600 },
		{ key: "", cost: 300, previousCost: 400 },
	],
})

/** The page entered at `search`, its window resolved and its sources answered. */
const entered = (search: Search, list: ReadonlyArray<SourceWire>) => {
	const resolved = pageUpdate(
		init({ search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		resolved,
		Message.CompletedLoadSources({
			key: resolved.sources.key ?? "",
			result: Result.succeed(sources(list)),
		}),
	)
}

/** Every read of the window answered. */
const answered = (model: Model, totalsAnswer = totals()): Model =>
	Arr.reduce(
		[
			Message.CompletedLoadTotals({
				key: model.totals.key ?? "",
				result: Result.succeed(totalsAnswer),
			}),
			Message.CompletedLoadTimeseries({
				key: model.timeseries.key ?? "",
				result: Result.succeed(timeseries),
			}),
			Message.CompletedLoadBreakdown({
				key: model.breakdown.key ?? "",
				result: Result.succeed(breakdown),
			}),
		],
		model,
		(next, message) => pageUpdate(next, message).model,
	)

const populated = (search: Search = { groupBy: "region" }, totalsAnswer = totals()): Model =>
	answered(entered(search, [source()]).model, totalsAnswer)

describe("cost page", () => {
	test("an org with no cost source gets the connect on-ramp and no warehouse read", () => {
		const step = entered({}, [])
		expect(names(step.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(text("No cost source yet")).toExist(),
			expectView(text(/AWS bills Cost Explorer requests at USD.0\.01 each/)).toExist(),
			expectView(role("link", { name: "Connect AWS" })).toHaveAttr(
				"href",
				"/sources/new?integration=aws",
			),
			// An account already connected turns its Cost module on from the AWS integration.
			expectView(role("link", { name: "Turn on Cost for a connected account" })).toHaveAttr(
				"href",
				"/integrations?integration=aws",
			),
			expectView(text("Group by")).not.toExist(),
			expectView(text("Sources")).not.toExist(),
		)
	})

	test("sources that have not synced yet say when the first sync runs, and list themselves", () => {
		const step = entered({}, [
			source({
				status: "pending",
				watermarkDate: null,
				backfillDate: null,
				historyComplete: false,
				lastSyncedAt: null,
				requestsThisMonth: 0,
			}),
		])
		expect(names(step.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(text("Waiting for the first sync")).toExist(),
			expectView(text(/The first sync runs within the hour/)).toExist(),
			expectView(text("123456789012")).toExist(),
			expectView(text("Waiting for first sync")).toExist(),
			expectView(text("Group by")).not.toExist(),
		)
	})

	test("a synced source asks for the totals, the daily series and the breakdown of the window", () => {
		const step = entered({}, [source()])
		expect(inputOf(step.commands, "FetchCostTotals")).toEqual(window)
		expect(inputOf(step.commands, "FetchCostTimeseries")).toEqual({
			...window,
			groupBy: "cloud_service",
			limit: 8,
		})
		expect(inputOf(step.commands, "FetchCostBreakdown")).toMatchObject({
			groupBy: "cloud_service",
			sortBy: "cost",
		})
	})

	test("populated: the figures, the change as worse when cost rose, the rows and an empty key's placeholder", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated()),
			resolveTheme,
			expectView(text("$1,200.00")).toExist(),
			expectView(text("+$200.00")).toExist(),
			expectView(text("$40.00")).toExist(),
			expectView(text("against the 30 days before")).toExist(),
			expectView(
				text("The last 2 days are not final yet. The provider can still restate them."),
			).toExist(),
			expectView(text(/Lighter bars from Nov 9 are not final yet/)).toExist(),
			expectView(role("link", { name: "north-1" })).toExist(),
			expectView(text("$900.00")).toExist(),
			expectView(text("75%")).toExist(),
			expectView(text("No region")).toExist(),
			expectView(text("-$100.00")).toExist(),
			expectView(text("Synced through Nov 9")).toExist(),
			expectView(text("86 provider requests this month (USD 0.86)")).toExist(),
		)
	})

	test("a window with cost in several currencies shows one and names the others", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated({ groupBy: "region" }, totals({ currencies: ["USD", "EUR", "GBP"] }))),
			resolveTheme,
			expectView(
				text("Showing USD. This window also has cost in EUR, GBP, which is not added in."),
			).toExist(),
			expectView(text("$1,200.00")).toExist(),
		)
	})

	test("a row links to the view filtered to it; the chip removes the filter again", () => {
		const model = populated()
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(role("link", { name: "north-1" })).toHaveAttr(
				"href",
				"/cost?groupBy=region&region=%5B%22north-1%22%5D",
			),
			// The empty key filters too: its placeholder is only how it reads.
			expectView(role("link", { name: "No region" })).toHaveAttr(
				"href",
				"/cost?groupBy=region&region=%5B%22%22%5D",
			),
		)
		const filtered = routeChanged(model, { search: { groupBy: "region", region: ["north-1"] } }, context)
		// Figures, chart and table all read under the filter.
		expect(inputOf(filtered.commands, "FetchCostTimeseries")).toMatchObject({
			filters: { region: ["north-1"] },
		})
		expect(inputOf(filtered.commands, "FetchCostTotals")).toEqual({
			...window,
			filters: { region: ["north-1"] },
		})
		expect(inputOf(filtered.commands, "FetchCostBreakdown")).toMatchObject({
			filters: { region: ["north-1"] },
		})
		scene(
			{ update: pageUpdate, view },
			given(answered(filtered.model)),
			resolveTheme,
			// The filtered row has nothing left to add.
			expectView(role("link", { name: "north-1" })).not.toExist(),
			click(role("button", { name: "Remove filter: Region is north-1" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/cost?groupBy=region", isReplace: false }),
			),
		)
	})

	test("picking another grouping moves the URL, then re-reads the chart and the table, not the totals", () => {
		const model = populated({})
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			click(role("button", { name: "Usage type" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/cost?groupBy=usage_type", isReplace: false }),
			),
		)
		const regrouped = routeChanged(model, { search: { groupBy: "usage_type" } }, context)
		expect(names(regrouped.commands)).not.toContain("FetchCostTotals")
		expect(inputOf(regrouped.commands, "FetchCostTimeseries")).toMatchObject({
			groupBy: "usage_type",
			limit: 8,
		})
		expect(inputOf(regrouped.commands, "FetchCostBreakdown")).toMatchObject({ groupBy: "usage_type" })
	})

	test("sorting by change moves the URL, and the breakdown alone is read again in that order", () => {
		const model = populated()
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			click(role("button", { name: "Change" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/cost?groupBy=region&sort=change",
					isReplace: false,
				}),
			),
		)
		const sorted = routeChanged(model, { search: { groupBy: "region", sort: "change" } }, context)
		expect(names(sorted.commands)).toEqual(["FetchCostBreakdown"])
		expect(inputOf(sorted.commands, "FetchCostBreakdown")).toMatchObject({ sortBy: "change" })
	})

	test("reads that all fail show one error, and Try again asks for each of them", () => {
		const step = entered({}, [source()]).model
		const failure = Result.fail(toLoadFailure("api down"))
		const failed = Arr.reduce(
			[
				Message.CompletedLoadTotals({ key: step.totals.key ?? "", result: failure }),
				Message.CompletedLoadTimeseries({ key: step.timeseries.key ?? "", result: failure }),
				Message.CompletedLoadBreakdown({ key: step.breakdown.key ?? "", result: failure }),
			],
			step,
			(next, message) => pageUpdate(next, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			resolveTheme,
			expectView(text("Couldn't load cost")).toExist(),
			expectView(text("Couldn't load daily cost")).not.toExist(),
			// The sources still answer what is connected.
			expectView(text("123456789012")).toExist(),
		)
		const retried = names(pageUpdate(failed, Message.ClickedRetry()).commands)
		expect(retried).toContain("FetchCostTotals")
		expect(retried).toContain("FetchCostTimeseries")
		expect(retried).toContain("FetchCostBreakdown")
		// The sources answered: Try again leaves them alone.
		expect(retried).not.toContain("FetchCostSources")
	})

	test("a failed sources read shows the error, reads nothing more, and Try again asks for it", () => {
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		).model
		const failed = pageUpdate(
			resolved,
			Message.CompletedLoadSources({
				key: resolved.sources.key ?? "",
				result: Result.fail(toLoadFailure("api down")),
			}),
		)
		expect(names(failed.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			resolveTheme,
			expectView(text("Couldn't load cost")).toExist(),
			expectView(text("No cost source yet")).not.toExist(),
		)
		expect(names(pageUpdate(failed.model, Message.ClickedRetry()).commands)).toEqual(["FetchCostSources"])
	})

	test("a source whose sync fails shows the provider's error; a paused one says its history stays", () => {
		const step = entered({}, [
			source({ status: "error", lastError: "AccessDeniedException: not authorized" }),
			source({
				id: "0190f2b3-0000-7000-8000-00000000c058",
				accountId: "210987654321",
				status: "paused",
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(answered(step.model)),
			resolveTheme,
			expectView(text("Sync failing")).toExist(),
			expectView(text("AccessDeniedException: not authorized")).toExist(),
			expectView(text("This connection no longer supplies cost. Its history stays.")).toExist(),
		)
	})

	test("no change is shown against a period a source is still backfilling", () => {
		// The window starts Oct 12 and covers 30 days: the period before starts Sep 12.
		const backfilling = (backfillDate: string) =>
			answered(
				entered({ groupBy: "region" }, [
					source({ status: "syncing", historyComplete: false, backfillDate }),
				]).model,
			)
		scene(
			{ update: pageUpdate, view },
			given(backfilling("2026-10-01")),
			resolveTheme,
			expectView(text("The 30 days before are still syncing")).toExist(),
			expectView(text("+$200.00")).not.toExist(),
			expectView(text("+$300.00")).not.toExist(),
		)
		// History that reaches the start of the period before is enough, complete or not.
		scene(
			{ update: pageUpdate, view },
			given(backfilling("2026-09-01")),
			resolveTheme,
			expectView(text("+$200.00")).toExist(),
			expectView(text("The 30 days before are still syncing")).not.toExist(),
		)
	})

	test("a fraction of a cent of credit reads as zero, not as a negative zero", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated({ groupBy: "region" }, totals({ cost: -0.0004, previousCost: 0 }))),
			resolveTheme,
			expectView(text("-$0.00")).not.toExist(),
		)
	})

	test("a changed time zone resolves the day window again before it reads anything", () => {
		// The presets are whole days in the reader's zone: the old window would be the wrong days.
		const moved: PageContext = { ...context, timeZone: "Pacific/Auckland" }
		expect(names(contextChanged(populated(), moved).commands)).toEqual(["ResolveCostWindow"])
	})

	test("a source held before its first pull is not called paused", () => {
		const step = entered({}, [
			source({
				status: "held",
				watermarkDate: null,
				backfillDate: null,
				lastSyncedAt: null,
				lastError: "Cloud cost is not enabled for this organization.",
				lastErrorReason: "rollout",
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(text("No cost read yet")).toExist(),
			expectView(text("The sync is on hold. The source below says why.")).toExist(),
			expectView(text("Cloud cost is not enabled for this organization.")).toExist(),
			expectView(text(/Each source below is paused/)).not.toExist(),
		)
	})

	test("a source the sync holds says why, and does not read as failing", () => {
		const step = entered({}, [
			source({
				status: "held",
				lastError: "This month's provider request budget is spent; pulls resume next month.",
				lastErrorReason: "budget",
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(answered(step.model)),
			resolveTheme,
			expectView(text("On hold")).toExist(),
			expectView(
				text("This month's provider request budget is spent; pulls resume next month."),
			).toExist(),
			expectView(text("Sync failing")).not.toExist(),
		)
	})
})
