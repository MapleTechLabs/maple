import { OrgId } from "@maple/domain"
import { type LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Effect, Option, Order, Record as Rec, Result, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../page/contract"
import { Message as AnalyticsMessage, type SlotName } from "../page/analytics/message"
import { Model as AnalyticsModel, type SearchTable } from "../page/analytics/model"
import { searchSortOf } from "../page/analytics/requests"
import type { SearchMetrics } from "../page/analytics/search-metrics"
import * as Analytics from "../page/analytics/update"
import { view as analyticsView } from "../page/analytics/view"
import type { Resources } from "../platform/resources"
import { AnalyticsSearch } from "../route/search"
import {
	OVERVIEW_BREAKDOWNS,
	OVERVIEW_PAGEVIEWS,
	OVERVIEW_PAGES,
	OVERVIEW_SUMMARY,
	OVERVIEW_TIMESERIES,
	SEARCH_EVENTS,
	SEARCH_LANDING,
	SEARCH_NOW_MS,
	SEARCH_OVERVIEW,
	SEARCH_QUERIES,
	SEARCH_STATUS,
	SEARCH_TIMESERIES,
	SEARCH_WINDOW,
} from "./analytics-search-fixture"
import { keepLocal } from "./local-commands"

// `/lab/analytics-search`: Web analytics' Search tab over fixtures. Sorting, the tiles, the filters
// and the property picker all work: each read the page asks for is answered here. `?state=` picks
// a start; `overview` and `overview-connected` open the Overview tab, for its pointer to Search.

export const LabState = Schema.Literals([
	"populated",
	"conversions",
	"history",
	"loading",
	"empty",
	"error",
	"partial",
	"recent",
	"importing",
	"disconnected",
	"revoked",
	"unpicked",
	"overview",
	"overview-connected",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "populated",
	),
}))

type Search = typeof AnalyticsSearch.Type

export const Model = Schema.Struct({ state: LabState, page: AnalyticsModel })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotPageMessage: { message: AnalyticsMessage } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_search"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

/** The warehouse's order: the sorted metric, then the busier row, then the name. */
const ordered = <Row extends SearchMetrics>(
	model: AnalyticsModel,
	table: SearchTable,
	rows: ReadonlyArray<Row>,
	name: (row: Row) => string,
): ReadonlyArray<Row> => {
	const sort = searchSortOf(model, table)
	const key = sort.key === "name" ? "clicks" : sort.key
	const byKey = Order.mapInput(Order.Number, (row: Row) => row[key])
	return Arr.sort(
		rows,
		Order.combineAll([
			sort.key !== "name" && sort.dir === "asc" ? byKey : Order.flip(byKey),
			Order.flip(
				Order.mapInput(
					Order.Number,
					(row: Row) => row[key === "impressions" ? "clicks" : "impressions"],
				),
			),
			Order.mapInput(Order.String, name),
		]),
	)
}

const statusOf = (state: LabState) => {
	const [first, ...rest] = SEARCH_STATUS.sites
	if (state === "disconnected" || state === "overview")
		return { ...SEARCH_STATUS, connected: false, sites: [] }
	if (state === "revoked") return { ...SEARCH_STATUS, revoked: true }
	if (state === "unpicked")
		return {
			...SEARCH_STATUS,
			sites: Arr.map(SEARCH_STATUS.sites, (site) => ({ ...site, enabled: false })),
		}
	if (first === undefined) return SEARCH_STATUS
	if (state === "importing")
		return { ...SEARCH_STATUS, sites: [{ ...first, watermarkDate: null, backfillDate: null }, ...rest] }
	if (state === "history")
		return { ...SEARCH_STATUS, sites: [{ ...first, backfillDate: "2026-10-20" }, ...rest] }
	return SEARCH_STATUS
}

/** What the API would answer `slot` with; `None` leaves it waiting. */
const answerOf = (
	state: LabState,
	model: AnalyticsModel,
	slot: SlotName,
): Option.Option<Result.Result<unknown, LoadFailure>> => {
	if (slot === "searchStatus") return Option.some(Result.succeed(statusOf(state)))
	if (isOverview(state))
		return Option.map(Option.fromNullishOr(OVERVIEW_ANSWERS.get(slot)), (answer) =>
			Result.succeed(answer),
		)
	if (slot === "breakdowns") return Option.some(Result.succeed(NO_BREAKDOWNS))
	if (slot === "events") return Option.some(Result.succeed(SEARCH_EVENTS))
	if (state === "loading") return Option.none()
	if (state === "error" || (state === "partial" && slot !== "searchLanding"))
		return Option.some(Result.fail(toLoadFailure("The warehouse did not answer in time")))
	const isEmpty = state === "empty" || state === "recent"
	switch (slot) {
		case "searchOverview":
			return Option.some(
				Result.succeed(
					isEmpty
						? {
								clicks: 0,
								impressions: 0,
								ctr: 0,
								position: 0,
								previous: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
							}
						: SEARCH_OVERVIEW,
				),
			)
		case "searchTimeseries":
			return Option.some(Result.succeed(isEmpty ? [] : SEARCH_TIMESERIES))
		case "searchQueries":
			return Option.some(
				Result.succeed(isEmpty ? [] : ordered(model, "queries", SEARCH_QUERIES, (row) => row.query)),
			)
		case "searchLanding":
			return Option.some(
				Result.succeed(
					isEmpty
						? []
						: Arr.map(
								ordered(model, "pages", SEARCH_LANDING, (row) => row.page),
								(row) =>
									model.search.eventName === undefined
										? row
										: { ...row, conversions: Math.round(row.sessions * 0.06) },
							),
				),
			)
		default:
			return Option.none()
	}
}

const isWaiting = (model: AnalyticsModel, slot: SlotName): boolean => {
	const data: AsyncData.AsyncData<unknown, unknown> = model[slot].data
	return AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
}

/** The event rail waits for the breakdowns, so they answer first, empty. */
const NO_BREAKDOWNS = {
	referrerHosts: [],
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

const isOverview = (state: LabState): boolean => state === "overview" || state === "overview-connected"

/** The Overview tab's reads, each answered once; the rest (the live badge) stay unasked. */
const OVERVIEW_ANSWERS = new Map<SlotName, unknown>([
	["breakdowns", OVERVIEW_BREAKDOWNS],
	["events", SEARCH_EVENTS],
	["summary", OVERVIEW_SUMMARY],
	["mix", OVERVIEW_SUMMARY],
	["previousSummary", OVERVIEW_SUMMARY],
	["timeseries", OVERVIEW_TIMESERIES],
	["pageviews", OVERVIEW_PAGEVIEWS],
	["previousPageviews", OVERVIEW_PAGEVIEWS],
	["pages", OVERVIEW_PAGES],
])

const LAB_SLOTS: ReadonlyArray<SlotName> = [
	"searchStatus",
	"breakdowns",
	"events",
	"searchOverview",
	"searchTimeseries",
	"searchQueries",
	"searchLanding",
	"summary",
	"mix",
	"previousSummary",
	"timeseries",
	"pageviews",
	"previousPageviews",
	"pages",
]

/** Answers every read the page is waiting on; the status answer asks for the rest, so twice. */
const settle = (state: LabState, model: AnalyticsModel): AnalyticsModel =>
	Arr.reduce([0, 1], model, (current) =>
		Arr.reduce(LAB_SLOTS, current, (next, slot) =>
			isWaiting(next, slot)
				? Option.match(answerOf(state, next, slot), {
						onNone: () => next,
						onSome: (result) =>
							Analytics.update(
								next,
								AnalyticsMessage.CompletedFetch({ slot, key: next[slot].key ?? "", result }),
								LAB_CONTEXT,
							).model,
					})
				: next,
		),
	)

const decodeSearch = Schema.decodeUnknownOption(AnalyticsSearch)

/** The search a page navigation lands on, read off its URL. */
const searchOfUrl = (url: string, fallback: Search): Search =>
	Option.getOrElse(
		decodeSearch(Rec.fromEntries([...new URL(url, "https://lab.local").searchParams.entries()])),
		() => fallback,
	)

type PageCommand = Command.Command<AnalyticsMessage, never, Resources>

const lift = (commands: ReadonlyArray<PageCommand> | undefined) =>
	Command.mapMessages(keepLocal(commands), (message) => Message.GotPageMessage({ message }))

export const init = (flags: Flags): Return => {
	const search: Search = isOverview(flags.state)
		? { timePreset: "1mo" }
		: flags.state === "conversions"
			? { tab: "search", timePreset: "1mo", eventName: "signup_completed" }
			: { tab: "search", timePreset: flags.state === "recent" ? "24h" : "1mo" }
	const entered = Analytics.init({ search }, LAB_CONTEXT)
	const windowed = Analytics.update(
		entered.model,
		AnalyticsMessage.CompletedResolveWindow({
			window: SEARCH_WINDOW,
			nowMs: SEARCH_NOW_MS,
			mode: "Load",
		}),
		LAB_CONTEXT,
	)
	return {
		model: { state: flags.state, page: settle(flags.state, windowed.model) },
		commands: lift(entered.commands),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: child }) => {
			const step = Analytics.update(model.page, child, LAB_CONTEXT)
			const out = step.outMessage
			if (out?._tag !== "RequestedNavigation")
				return {
					model: { ...model, page: settle(model.state, step.model) },
					commands: lift(step.commands),
				}
			const moved = Analytics.routeChanged(
				step.model,
				{ search: searchOfUrl(out.url, step.model.search) },
				LAB_CONTEXT,
			)
			return {
				model: { ...model, page: settle(model.state, moved.model) },
				commands: [...lift(step.commands), ...lift(moved.commands)],
			}
		},
	})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-analytics-search",
		model: model.page,
		view: analyticsView,
		viewInputs: { context: LAB_CONTEXT },
		toParentMessage: (message: AnalyticsMessage) => Message.GotPageMessage({ message }),
	})
