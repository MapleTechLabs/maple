import { filtersFromSearch, hasActiveFilters, type AnalyticsFilters } from "../../components/analytics/filters"
import { previousWindow } from "../../components/analytics/previous-window"
import { sparkBucketSeconds } from "../../components/analytics/ai/ai-traffic-model"
import { chartBucketSeconds } from "../../components/infra/chart-units"
import { Option, Struct } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { TimeWindow } from "../../data/time-range"
import type { Resources } from "../../platform/resources"
import type { PageContext } from "../contract"
import { presenceOf } from "../kit/signal-presence"
import {
	FetchAiCrawlers,
	FetchAiReferrals,
	FetchBreakdowns,
	FetchEvents,
	FetchLive,
	FetchPages,
	FetchPageviews,
	FetchSummary,
	FetchTimeseries,
	FetchTraceSamples,
} from "./command"
import { type Message, SlotName } from "./message"
import type { Model, Search } from "./model"

// The reads the page makes, each keyed by its input (S6).

type Cmd = Command.Command<Message, never, Resources>

const ANALYTICS_TABS = ["overview", "ai"] as const
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number]
export const tabOf = (search: Search): AnalyticsTab => ANALYTICS_TABS.find((tab) => tab === search.tab) ?? "overview"

export const filtersOf = (search: Search): AnalyticsFilters => filtersFromSearch({ ...search })

const PAGES_LIMIT = 100
const EVENTS_LIMIT = 100
const BREAKDOWN_LIMIT = 50
const CRAWLED_PAGES_LIMIT = 50
const TRACE_SAMPLES_LIMIT = 10

type Request = Readonly<{
	slot: SlotName
	fn: string
	input: object
	command: (key: string) => Cmd
}>

/** The overview content mounts unless the org never sent sessions and nothing is filtered. */
export const showsOverviewContent = (model: Model): boolean =>
	!(presenceOf(model.presence, "sessions").status === "absent" && !hasActiveFilters(filtersOf(model.search)))

const plan = (model: Model, window: TimeWindow): ReadonlyArray<Request> => {
	const filters = filtersOf(model.search)
	const { startTime, endTime } = window
	const page: ReadonlyArray<Request> = [
		{
			slot: "breakdowns",
			fn: "getWebAnalyticsBreakdowns",
			input: { startTime, endTime, limitPerDimension: BREAKDOWN_LIMIT, ...filters },
			command: (key) =>
				FetchBreakdowns({ slot: "breakdowns", key, input: { startTime, endTime, limitPerDimension: BREAKDOWN_LIMIT, ...filters } }),
		},
		{
			slot: "events",
			fn: "getWebAnalyticsEvents",
			input: { startTime, endTime, limit: EVENTS_LIMIT, ...filters },
			command: (key) => FetchEvents({ slot: "events", key, input: { startTime, endTime, limit: EVENTS_LIMIT, ...filters } }),
		},
		{
			slot: "live",
			fn: "getWebAnalyticsLive",
			input: { ...filters },
			command: (key) => FetchLive({ slot: "live", key, input: { ...filters } }),
		},
	]
	const summary = (slot: SlotName, data: AnalyticsFilters & TimeWindow): Request => ({
		slot,
		fn: "getWebAnalyticsSummary",
		input: data,
		command: (key) => FetchSummary({ slot, key, input: data }),
	})
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const previous = previousWindow(startTime, endTime)
	const pageviews = (slot: SlotName, range: TimeWindow): Request => {
		const input = { ...range, ...filters, bucketSeconds }
		return { slot, fn: "getWebAnalyticsPageviews", input, command: (key) => FetchPageviews({ slot, key, input }) }
	}
	const overview: ReadonlyArray<Request> =
		tabOf(model.search) === "overview" && showsOverviewContent(model)
			? [
					summary("summary", { startTime, endTime, ...filters }),
					summary("mix", { startTime, endTime, ...filters, traffic: "all" }),
					{
						slot: "timeseries",
						fn: "getWebAnalyticsTimeseries",
						input: { startTime, endTime, ...filters, bucketSeconds },
						command: (key) =>
							FetchTimeseries({ slot: "timeseries", key, input: { startTime, endTime, ...filters, bucketSeconds } }),
					},
					pageviews("pageviews", window),
					{
						slot: "pages",
						fn: "getWebAnalyticsPages",
						input: { startTime, endTime, ...filters, limit: PAGES_LIMIT },
						command: (key) => FetchPages({ slot: "pages", key, input: { startTime, endTime, ...filters, limit: PAGES_LIMIT } }),
					},
					summary("previousSummary", { ...previous, ...filters }),
					pageviews("previousPageviews", previous),
					...(filters.eventName === undefined
						? []
						: [
								{
									slot: "traceSamples" as const,
									fn: "productEventTraceSamples",
									input: { eventName: filters.eventName, startTime, endTime, limit: TRACE_SAMPLES_LIMIT },
									command: (key: string) =>
										FetchTraceSamples({
											slot: "traceSamples",
											key,
											input: { eventName: filters.eventName ?? "", startTime, endTime, limit: TRACE_SAMPLES_LIMIT },
										}),
								},
							]),
				]
			: []
	const aiBucket = sparkBucketSeconds(startTime, endTime)
	const referrals = (slot: SlotName, range: TimeWindow): Request => {
		const input = { ...range, bucketSeconds: aiBucket, ...filters }
		return { slot, fn: "getWebAnalyticsAiReferrals", input, command: (key) => FetchAiReferrals({ slot, key, input }) }
	}
	// Picked, not assigned: an unset filter stays out of the body (an `undefined` key encodes as null).
	const crawlersInput = {
		startTime,
		endTime,
		...Struct.pick(filters, ["host", "pagePath"]),
		pagesLimit: CRAWLED_PAGES_LIMIT,
	}
	const ai: ReadonlyArray<Request> =
		tabOf(model.search) === "ai"
			? [
					referrals("aiReferrals", window),
					referrals("previousAiReferrals", previous),
					{
						slot: "aiCrawlers",
						fn: "getWebAnalyticsAiCrawlers",
						input: crawlersInput,
						command: (key) => FetchAiCrawlers({ slot: "aiCrawlers", key, input: crawlersInput }),
					},
					summary("summary", { startTime, endTime, ...filters }),
				]
			: []
	return [...page, ...overview, ...ai]
}

type AnySlot = Keyed.Keyed<unknown, unknown>

const PAGE_SLOTS: ReadonlyArray<SlotName> = ["breakdowns", "events"]
const SLOT_NAMES = SlotName.literals

/** Requests every slot the visible content reads; slots whose key held (and that answered) stay put. */
export const requestSlots = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	mode: Keyed.RequestMode,
	only?: ReadonlyArray<SlotName>,
): { readonly model: Model; readonly commands: ReadonlyArray<Cmd> } => {
	const requests = plan(model, window).filter((request) => only === undefined || only.includes(request.slot))
	// Two slots asking the same atom (the mix under `traffic: all`) share one request.
	const sent = new Set<string>()
	const slots: Readonly<Record<SlotName, AnySlot>> = model
	return requests.reduce<{ model: Model; commands: ReadonlyArray<Cmd> }>(
		(state, request) => {
			const key = requestKey(context.orgId, request.fn, { data: request.input })
			const current: AnySlot = state.model[request.slot]
			// An atom another slot already holds answers from the cache, like a shared atom does.
			const cached = SLOT_NAMES.map((name) => slots[name]).find(
				(slot) => slot.key === key && AsyncData.isSuccess(slot.data),
			)
			if (mode === "Load" && current.key !== key && cached !== undefined)
				return { ...state, model: { ...state.model, [request.slot]: cached } }
			// The page's own atoms (breakdowns, events) sit outside the header reload: only a new key refetches them.
			const slotMode = mode === "Refresh" && only === undefined && PAGE_SLOTS.includes(request.slot) ? "Load" : mode
			const next = Keyed.request(current, key, slotMode)
			const isDuplicate = sent.has(key)
			sent.add(key)
			return Option.match(next, {
				onNone: () => state,
				onSome: (slot) => ({
					model: { ...state.model, [request.slot]: slot },
					commands: isDuplicate ? state.commands : [...state.commands, request.command(key)],
				}),
			})
		},
		{ model, commands: [] },
	)
}
