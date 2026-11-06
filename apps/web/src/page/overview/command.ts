import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import {
	getCustomChartTimeSeries,
	getOverviewThroughputRefinement,
	getOverviewTimeSeries,
} from "@maple/web-data/warehouse/custom-charts"
import { getServiceUsage } from "@maple/web-data/warehouse/service-usage"
import { getServiceHealthSnapshot } from "@maple/web-data/warehouse/services"
import { Clock, Duration, Effect, Option, Schema, Array as Arr, Record as Rec } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { loadAnomalyServiceCounts } from "../../data/anomaly-service-counts"
import { loadServicesFacets } from "../../data/services-facets-probe"
import { TimeWindow } from "../../data/time-range"
import { loadSignalPresences } from "../kit/signal-presence"
import { Message } from "./message"
import { FacetsHint } from "./model"

/** `dashboardFacetsHintAtomFamily`'s default before any facets load. */
export const DEFAULT_HINT: FacetsHint = { environment: null, preset: "24h", seen: false }

const hintKey = (orgId: string) => `maple.dashboard.facets-hint.${orgId}`
const HintJson = Schema.fromJsonString(FacetsHint)
const decodeHint = Schema.decodeUnknownOption(HintJson)
const encodeHint = Schema.encodeSync(HintJson)

/** Entry: the clock (`useEffectiveTimeRange`, `facetsRange`) and the stored facets hint. */
export const ReadEntry = Command.define("ReadOverviewEntry", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedReadEntry],
	execute: ({ orgId }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedReadEntry({
				nowMs,
				hint: Option.getOrElse(
					Option.flatMap(readLocalStorage(hintKey(orgId)), decodeHint),
					() => DEFAULT_HINT,
				),
			}),
		),
})

/** Reload: the real clock, so the window re-resolves unsnapped. */
export const ResolveClock = Command.define("ResolveOverviewClock", {
	messages: [Message.CompletedResolveClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedResolveClock({ nowMs })),
})

/** `FacetsHintPersister`: written once facets resolve, and again when the derived hint changes. */
export const SaveFacetsHint = Command.define("SaveOverviewFacetsHint", {
	args: { orgId: Schema.String, hint: FacetsHint },
	messages: [Message.CompletedSaveFacetsHint],
	execute: ({ orgId, hint }) =>
		Effect.sync(() => {
			writeLocalStorage(hintKey(orgId), encodeHint(hint))
			return Message.CompletedSaveFacetsHint()
		}),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteOverviewReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

const Names = Schema.optional(Schema.Array(Schema.String))
const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

/** The window plus the environment filter (`environmentFilter`). */
export const ScopedInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Names,
})
export type ScopedInput = typeof ScopedInput.Type

/** The log volume input: the namespace pin is injected per site (`namespaces`). */
export const LogInput = Schema.Struct({ ...ScopedInput.fields, namespaces: Names })
export type LogInput = typeof LogInput.Type

export const UsageInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	previousStartTime: Schema.optional(Schema.String),
	previousEndTime: Schema.optional(Schema.String),
})
export type UsageInput = typeof UsageInput.Type

export const RefinementInput = Schema.Struct({ ...ScopedInput.fields, samplingActive: Schema.Boolean })
export type RefinementInput = typeof RefinementInput.Type

// Fetches carry their request key back so `update` drops a superseded answer (S6).

/** Through the shared probe: the shell's namespace list reads the same answer (`ServicesFacetsProbe`). */
export const FetchFacets = Command.define("FetchOverviewFacets", {
	args: { key: Schema.String, window: TimeWindow, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window, refresh }) =>
		loadServicesFacets(window, { refresh, key }).pipe(
			Effect.mapBoth({
				onSuccess: ({ data }) => ({
					environments: Arr.map(data.environments, (facet) => facet.name),
					services: Arr.map(data.services, (facet) => facet.name),
				}),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const FetchSnapshot = Command.define("FetchServiceHealthSnapshot", {
	args: { key: Schema.String, input: ScopedInput },
	messages: [Message.CompletedFetchSnapshot],
	execute: ({ key, input }) =>
		getServiceHealthSnapshot({
			data: {
				startTime: input.startTime,
				endTime: input.endTime,
				environments: mutable(input.environments),
			},
		}).pipe(
			Effect.mapBoth({ onSuccess: (response) => response.data, onFailure: toLoadFailure }),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSnapshot({ key, result })),
		),
})

/** `openAnomalyServiceCountsAtom`. */
export const FetchAnomalies = Command.define("FetchOverviewAnomalyCounts", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchAnomalies],
	execute: ({ key, refresh }) =>
		loadAnomalyServiceCounts(key, { refresh }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAnomalies({ key, result })),
		),
})

/** `ServiceUsageCards`: current and previous totals in one request, summed per signal (`sumTotals`). */
export const FetchUsage = Command.define("FetchOverviewServiceUsage", {
	args: { key: Schema.String, input: UsageInput },
	messages: [Message.CompletedFetchUsage],
	execute: ({ key, input }) =>
		getServiceUsage({ data: input }).pipe(
			Effect.mapBoth({
				onSuccess: (response) => ({
					totals: Arr.reduce(response.data, { logs: 0, traces: 0, metrics: 0 }, (acc, service) => ({
						logs: acc.logs + service.totalLogs,
						traces: acc.traces + service.totalTraces,
						metrics: acc.metrics + service.totalMetrics,
					})),
					previous: response.previousTotals ?? null,
				}),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchUsage({ key, result })),
		),
})

/** `getOverviewTimeSeriesResultAtom`: the request volume, error rate and latency buckets. */
export const FetchOverviewSeries = Command.define("FetchOverviewTimeSeries", {
	args: { key: Schema.String, input: ScopedInput },
	messages: [Message.CompletedFetchOverviewSeries],
	execute: ({ key, input }) =>
		getOverviewTimeSeries({
			data: {
				startTime: input.startTime,
				endTime: input.endTime,
				environments: mutable(input.environments),
			},
		}).pipe(
			Effect.mapBoth({ onSuccess: (response) => response.data, onFailure: toLoadFailure }),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOverviewSeries({ key, result })),
		),
})

/** The log volume card: one `count` series over logs, summed per bucket (`logPoints`). */
export const FetchLogSeries = Command.define("FetchOverviewLogVolume", {
	args: { key: Schema.String, input: LogInput },
	messages: [Message.CompletedFetchLogSeries],
	execute: ({ key, input }) =>
		getCustomChartTimeSeries({
			data: {
				source: "logs",
				metric: "count",
				groupBy: "none",
				startTime: input.startTime,
				endTime: input.endTime,
				filters: {
					serviceName: undefined,
					environments: mutable(input.environments),
					namespaces: mutable(input.namespaces),
				},
			},
		}).pipe(
			Effect.mapBoth({
				onSuccess: (response) =>
					Arr.map(response.data, (point) => ({
						bucket: point.bucket,
						throughput: Arr.reduce(
							Rec.values(point.series),
							0,
							(sum, value) => sum + (typeof value === "number" ? value : 0),
						),
					})),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchLogSeries({ key, result })),
		),
})

/** `getOverviewThroughputRefinementResultAtom`: exact pre-sampling volume, only while sampling is on. */
export const FetchRefinement = Command.define("FetchOverviewThroughputRefinement", {
	args: { key: Schema.String, input: RefinementInput },
	messages: [Message.CompletedFetchRefinement],
	execute: ({ key, input }) =>
		getOverviewThroughputRefinement({
			data: {
				startTime: input.startTime,
				endTime: input.endTime,
				environments: mutable(input.environments),
				samplingActive: input.samplingActive,
			},
		}).pipe(
			Effect.mapBoth({ onSuccess: (response) => response.data, onFailure: toLoadFailure }),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRefinement({ key, result })),
		),
})

export const LoadSignalPresence = Command.define("LoadOverviewSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})
