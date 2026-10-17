import { getCustomChartServiceSparklines } from "@maple/web-data/warehouse/custom-charts"
import {
	getServiceHealthBaseline,
	getServiceOverview,
	getServicesFacets,
	type GetServiceOverviewInput,
} from "@maple/web-data/warehouse/services"
import { Clock, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message, RequestMode } from "./message"

/** The overview, sparklines and baseline input: the window plus the URL filters, pin applied. */
export const OverviewInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
	namespaces: Schema.optional(Schema.Array(Schema.String)),
	commitShas: Schema.optional(Schema.Array(Schema.String)),
	excludedEnvironments: Schema.optional(Schema.Array(Schema.String)),
	excludedNamespaces: Schema.optional(Schema.Array(Schema.String)),
	excludedCommitShas: Schema.optional(Schema.Array(Schema.String)),
})
export type OverviewInput = typeof OverviewInput.Type

const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

const toWarehouseInput = (input: OverviewInput): GetServiceOverviewInput => ({
	startTime: input.startTime,
	endTime: input.endTime,
	environments: mutable(input.environments),
	namespaces: mutable(input.namespaces),
	commitShas: mutable(input.commitShas),
	excludedEnvironments: mutable(input.excludedEnvironments),
	excludedNamespaces: mutable(input.excludedNamespaces),
	excludedCommitShas: mutable(input.excludedCommitShas),
})

/** `useEffectiveTimeRange`: snapped on entry, re-resolved against the real clock on Reload. */
export const ResolveWindow = Command.define("ResolveServicesWindow", {
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

// Fetches carry their request key back so `update` drops a superseded answer (S6).

export const FetchOverview = Command.define("FetchServiceOverview", {
	args: { key: Schema.String, input: OverviewInput },
	messages: [Message.CompletedFetchOverview],
	execute: ({ key, input }) =>
		getServiceOverview({ data: toWarehouseInput(input) }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOverview({ key, result })),
		),
})

export const FetchSparklines = Command.define("FetchServiceSparklines", {
	args: { key: Schema.String, input: OverviewInput },
	messages: [Message.CompletedFetchSparklines],
	execute: ({ key, input }) =>
		getCustomChartServiceSparklines({ data: toWarehouseInput(input) }).pipe(
			Effect.map((response) =>
				Object.fromEntries(
					Object.entries(response.data).map(([service, points]) => [
						service,
						{
							throughput: points.map((point) => point.throughput),
							errorRate: points.map((point) => point.errorRate),
						},
					]),
				),
			),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSparklines({ key, result })),
		),
})

export const FetchFacets = Command.define("FetchServicesFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getServicesFacets({ data: window }).pipe(
			Effect.map(({ data }) => ({
				environments: data.environments,
				namespaces: data.namespaces,
				commitShas: data.commitShas,
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const BaselineInput = Schema.Struct({
	rangeStartTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
	namespaces: Schema.optional(Schema.Array(Schema.String)),
	excludedNamespaces: Schema.optional(Schema.Array(Schema.String)),
})
export type BaselineInput = typeof BaselineInput.Type

export const FetchBaseline = Command.define("FetchServiceHealthBaseline", {
	args: { key: Schema.String, input: BaselineInput },
	messages: [Message.CompletedFetchBaseline],
	execute: ({ key, input }) =>
		getServiceHealthBaseline({
			data: {
				rangeStartTime: input.rangeStartTime,
				environments: mutable(input.environments),
				namespaces: mutable(input.namespaces),
			},
		}).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchBaseline({ key, result })),
		),
})

/** `openAnomalyServiceCountsAtom`. */
export const FetchAnomalies = Command.define("FetchOpenAnomalyServiceCounts", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchAnomalies],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.anomalies.serviceCounts({ query: { status: "open" } })
			return response.data
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAnomalies({ key, result })),
		),
})

/** `commitsQueryAtom(shasKey)`: every deploy sha on screen in one request, first lines by sha. */
export const FetchCommitMessages = Command.define("FetchCommitMessages", {
	args: { key: Schema.String, shas: Schema.String },
	messages: [Message.CompletedFetchCommitMessages],
	execute: ({ key, shas }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.vcsCommitDetails({ query: { shas } })
			return Object.fromEntries(
				response.commits.map((commit) => [commit.sha, firstLine(commit.message)]),
			)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCommitMessages({ key, result })),
		),
})

// copied: `firstLine` (commit-sha-hover-card.tsx, a React module).
const firstLine = (message: string): string => {
	const index = message.indexOf("\n")
	return (index === -1 ? message : message.slice(0, index)).trim()
}

/** The empty state is on screen: resolves after the frame that painted it. */
export const MountEmptyState = Mount.define("MountServicesEmptyState", {
	messages: [Message.PaintedEmptyState],
	execute: () =>
		Effect.callback<ReturnType<typeof Message.PaintedEmptyState>>((resume) => {
			const handle = requestAnimationFrame(() =>
				requestAnimationFrame(() => resume(Effect.succeed(Message.PaintedEmptyState()))),
			)
			return Effect.sync(() => cancelAnimationFrame(handle))
		}),
})

/** The loaded table is on screen. */
export const MountTable = Mount.define("MountServicesTable", {
	messages: [Message.PaintedTable],
	execute: () =>
		Effect.callback<ReturnType<typeof Message.PaintedTable>>((resume) => {
			const handle = requestAnimationFrame(() =>
				requestAnimationFrame(() => resume(Effect.succeed(Message.PaintedTable()))),
			)
			return Effect.sync(() => cancelAnimationFrame(handle))
		}),
})

export const LoadSignalPresence = Command.define("LoadSignalPresence", {
	messages: [Message.CompletedLoadSignalPresence],
	execute: Effect.map(loadSignalPresences, (result) => Message.CompletedLoadSignalPresence({ result })),
})
