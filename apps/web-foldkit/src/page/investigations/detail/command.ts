import { ErrorIssueId, InvestigationId } from "@maple/domain/http"
import { getCustomChartTimeSeries } from "@maple/web-data/warehouse/custom-charts"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { loadKnownServices } from "../../chat/kit/known-services"
import { TraceId } from "@maple/domain"
import { Clock, Effect, type Result, Schema } from "effect"
import { Command } from "foldkit"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { readSpanHierarchy, spanHierarchyKey } from "../../traces/detail/command"
import { Message } from "./message"

/** `KnownServicesProvider`: the org's service names, read once a thread shows its scroller. */
export const LoadKnownServices = Command.define("LoadInvestigationKnownServices", {
	messages: [Message.CompletedLoadKnownServices],
	execute: Effect.map(loadKnownServices, (services) => Message.CompletedLoadKnownServices({ services })),
})

/** Whether the focused element is keyboard-focused: Base UI opens a tooltip on keyboard focus only. */
export const CheckTipFocus = Command.define("CheckInvestigationTipFocus", {
	args: { triggerId: Schema.String },
	messages: [Message.CheckedTipFocus],
	execute: ({ triggerId }) =>
		Effect.sync(() =>
			Message.CheckedTipFocus({
				triggerId,
				isFocusVisible: document.getElementById(triggerId)?.matches(":focus-visible") === true,
			}),
		),
})

/**
 * TanStack's `defaultPreload: "intent"`: a trace link hovered or focused runs the trace route's
 * loader, which warms its span hierarchy read. The answer is the warm cache, not this page's.
 */
export const PreloadTrace = Command.define("PreloadInvestigationTrace", {
	args: { orgId: Schema.String, traceId: Schema.String },
	messages: [Message.CompletedPreloadTrace],
	execute: ({ orgId, traceId }) =>
		Effect.gen(function* () {
			const decoded = Schema.decodeUnknownOption(TraceId)(traceId)
			// Through the read cache, so the trace page opening next joins or reuses this read.
			const key = (traceId: TraceId) => spanHierarchyKey(orgId, traceId, undefined)
			if (decoded._tag === "Some")
				yield* Effect.ignore(readSpanHierarchy(key(decoded.value), decoded.value, undefined))
			return Message.CompletedPreloadTrace()
		}),
})

const finish = <A, E, R, M>(effect: Effect.Effect<A, E, R>, toMessage: (result: Result.Result<A, LoadFailure>) => M) =>
	effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

export const ReadInvestigationClock = Command.define("ReadInvestigationClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const SignalWindowSchema = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})

/** `LogsRow`: log count by severity for the service over the incident window. */
export const FetchSignalLogs = Command.define("FetchInvestigationSignalLogs", {
	args: { key: Schema.String, service: Schema.String, window: SignalWindowSchema },
	messages: [Message.CompletedFetchLogs],
	execute: ({ key, service, window }) =>
		finish(
			Effect.map(
				getCustomChartTimeSeries({
					data: {
						source: "logs",
						metric: "count",
						groupBy: "severity",
						startTime: window.startTime,
						endTime: window.endTime,
						bucketSeconds: window.bucketSeconds,
						filters: { serviceName: service },
					},
				}),
				(response) => response.data.map((point) => ({ bucket: point.bucket, series: { ...point.series } })),
			),
			(result) => Message.CompletedFetchLogs({ key, result }),
		),
})

/** `TracesRow`: the service's busiest overview row over the window. */
export const FetchSignalTraces = Command.define("FetchInvestigationSignalTraces", {
	args: { key: Schema.String, service: Schema.String, startTime: Schema.String, endTime: Schema.String },
	messages: [Message.CompletedFetchTraces],
	execute: ({ key, service, startTime, endTime }) =>
		finish(
			Effect.map(getServiceOverview({ data: { startTime, endTime } }), (response) => {
				const row = response.data
					.filter((candidate) => candidate.serviceName === service)
					.toSorted((left, right) => right.spanCount - left.spanCount)[0]
				return row === undefined ? null : { spanCount: row.spanCount, p95LatencyMs: row.p95LatencyMs, errorRate: row.errorRate }
			}),
			(result) => Message.CompletedFetchTraces({ key, result }),
		),
})

/** `Escalation`: whether this run's diagnosis reached anyone. */
export const FetchEscalation = Command.define("FetchInvestigationEscalation", {
	args: { key: Schema.String, issueId: ErrorIssueId, investigationId: Schema.String },
	messages: [Message.CompletedFetchEscalation],
	execute: ({ key, issueId, investigationId }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleInternalApiClient
				const response = yield* client.errors.listIssueEscalations({ params: { issueId } })
				const attempt = response.attempts.find((candidate) => candidate.investigationId === investigationId)
				return attempt === undefined
					? null
					: {
							status: attempt.status,
							destinations: attempt.deliveries.map((delivery) => ({
								name: delivery.destinationName ?? delivery.destinationId,
								status: delivery.status,
							})),
						}
			}),
			(result) => Message.CompletedFetchEscalation({ key, result }),
		),
})

export const ResolveInvestigation = Command.define("ResolveInvestigation", {
	args: { id: InvestigationId },
	messages: [Message.CompletedResolve],
	execute: ({ id }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.investigations.updateStatus({ params: { id }, payload: { status: "resolved" } })
			}),
			(result) => Message.CompletedResolve({ result }),
		),
})

export const RestartInvestigation = Command.define("RestartInvestigation", {
	args: { id: InvestigationId },
	messages: [Message.CompletedRestart],
	execute: ({ id }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.investigations.restart({ params: { id } })
			}),
			(result) => Message.CompletedRestart({ result }),
		),
})
