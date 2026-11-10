import { RequestMode } from "@maple/views/data/keyed"
import { getProductEventTraceSamples } from "@maple/web-data/warehouse/product-events"
import {
	getWebAnalyticsAiCrawlers,
	getWebAnalyticsAiReferrals,
	getWebAnalyticsBreakdowns,
	getWebAnalyticsEvents,
	getWebAnalyticsLive,
	getWebAnalyticsPages,
	getWebAnalyticsPageviews,
	getWebAnalyticsSummary,
	getWebAnalyticsTimeseries,
	WebAnalyticsFilterFields,
} from "@maple/web-data/warehouse/web-analytics"
import {
	getSearchConsoleLandingPages,
	getSearchConsoleOverview,
	getSearchConsoleTimeseries,
	getSearchConsoleTopPages,
	getSearchConsoleTopQueries,
} from "@maple/web-data/warehouse/search-console"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { resolveWindow } from "../../data/time-range"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { loadSignalPresences } from "../kit/signal-presence"
import { Message, SlotName } from "./message"

// The page's reads. Every fetch answers `CompletedFetch` with its slot and key (S6); the request
// itself is the web-data function, with the input it was keyed on.

export const ResolveWindow = Command.define("ResolveAnalyticsWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

const Filters = WebAnalyticsFilterFields
const Window = { startTime: Schema.String, endTime: Schema.String }
const N = Schema.optional(Schema.Number)

const toMessage =
	(slot: SlotName, key: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetch({ slot, key, result })),
		)

const define = <Fields extends Schema.Struct.Fields, E, R>(
	name: string,
	fields: Fields,
	run: (input: Schema.Struct<Fields>["Type"]) => Effect.Effect<unknown, E, R>,
) =>
	Command.define(name, {
		args: { slot: SlotName, key: Schema.String, input: Schema.Struct(fields) },
		messages: [Message.CompletedFetch],
		execute: ({ slot, key, input }) => toMessage(slot, key)(run(input)),
	})

export const FetchBreakdowns = define(
	"FetchWebAnalyticsBreakdowns",
	{ ...Window, ...Filters, limitPerDimension: N },
	(data) => getWebAnalyticsBreakdowns({ data }),
)
export const FetchEvents = define("FetchWebAnalyticsEvents", { ...Window, ...Filters, limit: N }, (data) =>
	getWebAnalyticsEvents({ data }).pipe(Effect.map((response) => response.data)),
)
export const FetchLive = define("FetchWebAnalyticsLive", { ...Filters }, (data) =>
	getWebAnalyticsLive({ data }),
)
export const FetchSummary = define("FetchWebAnalyticsSummary", { ...Window, ...Filters }, (data) =>
	getWebAnalyticsSummary({ data }),
)
export const FetchTimeseries = define(
	"FetchWebAnalyticsTimeseries",
	{ ...Window, ...Filters, bucketSeconds: N },
	(data) => getWebAnalyticsTimeseries({ data }).pipe(Effect.map((response) => response.data)),
)
export const FetchPageviews = define(
	"FetchWebAnalyticsPageviews",
	{ ...Window, ...Filters, bucketSeconds: N },
	(data) => getWebAnalyticsPageviews({ data }).pipe(Effect.map((response) => response.data)),
)
export const FetchPages = define("FetchWebAnalyticsPages", { ...Window, ...Filters, limit: N }, (data) =>
	getWebAnalyticsPages({ data }).pipe(Effect.map((response) => response.data)),
)
export const FetchAiReferrals = define(
	"FetchWebAnalyticsAiReferrals",
	{ ...Window, ...Filters, bucketSeconds: N },
	(data) => getWebAnalyticsAiReferrals({ data }).pipe(Effect.map((response) => response.data)),
)
export const FetchAiCrawlers = define(
	"FetchWebAnalyticsAiCrawlers",
	{
		...Window,
		host: Schema.optional(Schema.String),
		pagePath: Schema.optional(Schema.String),
		pagesLimit: N,
	},
	(data) => getWebAnalyticsAiCrawlers({ data }),
)
export const FetchTraceSamples = define(
	"FetchProductEventTraceSamples",
	{ ...Window, eventName: Schema.String, limit: N },
	(data) => getProductEventTraceSamples({ data }).pipe(Effect.map((response) => response.data)),
)

// The Search tab. Status is the integration's own endpoint; the reads name one enabled property.
export const FetchSearchStatus = define("FetchSearchConsoleStatus", {}, () =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.searchConsoleStatus()
	}),
)

const SearchWindow = { siteUrl: Schema.String, ...Window, completeThrough: Schema.String }
const SearchOrder = {
	sortBy: Schema.optional(Schema.Literals(["clicks", "impressions", "ctr", "position"])),
	sortDir: Schema.optional(Schema.Literals(["asc", "desc"])),
}
const SearchList = { ...SearchWindow, ...SearchOrder, limit: N }

export const FetchSearchOverview = define("FetchSearchConsoleOverview", SearchWindow, (data) =>
	getSearchConsoleOverview({ data }),
)
export const FetchSearchTimeseries = define("FetchSearchConsoleTimeseries", SearchWindow, (data) =>
	getSearchConsoleTimeseries({ data }),
)
export const FetchSearchQueries = define("FetchSearchConsoleTopQueries", SearchList, (data) =>
	getSearchConsoleTopQueries({ data }),
)
export const FetchSearchPages = define("FetchSearchConsoleTopPages", SearchList, (data) =>
	getSearchConsoleTopPages({ data }),
)
export const FetchSearchLanding = define(
	"FetchSearchConsoleLandingPages",
	{ ...SearchWindow, ...SearchOrder, limit: N, conversionEvent: Schema.optional(Schema.String) },
	(data) => getSearchConsoleLandingPages({ data }),
)

export const LoadSignalPresence = Command.define("LoadAnalyticsSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

export const CompleteReloadSpin = Command.define("CompleteAnalyticsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
