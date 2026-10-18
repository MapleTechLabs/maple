import { ErrorIssueId, InvestigationId } from "@maple/domain/http"
import { getCustomChartTimeSeries } from "@maple/web-data/warehouse/custom-charts"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Clock, Effect, type Result, Schema } from "effect"
import { Command } from "foldkit"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { Message } from "./message"

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
