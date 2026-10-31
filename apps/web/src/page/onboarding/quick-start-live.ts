import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { currentWindow } from "../../data/time-range"

// The last screen, "You're live": what the org's own first day of data already shows, read once.

/** The busiest finding per surface, from the last 24 hours of services. */
export const LiveFindings = Schema.Struct({
	serviceCount: Schema.Number,
	slowest: Schema.NullOr(Schema.Struct({ serviceName: Schema.String, p95LatencyMs: Schema.Number })),
	mostErrors: Schema.NullOr(Schema.Struct({ serviceName: Schema.String, errorRate: Schema.Number })),
})
export type LiveFindings = typeof LiveFindings.Type

export const LiveData = AsyncData.Schema(LiveFindings, LoadFailure)
export type LiveData = typeof LiveData.schema.Type

export const LiveMessage = defineMessageUnion({
	LoadedFindings: { result: Schema.Result(LiveFindings, LoadFailure) },
})
export type LiveMessage = typeof LiveMessage.Type

type ServiceRow = Readonly<{ serviceName: string; p95LatencyMs: number; errorRate: number }>

/** The slowest service by p95 and the one failing most often; a service with no errors is not "most errors". */
export const findingsOf = (rows: ReadonlyArray<ServiceRow>): LiveFindings => {
	const slowest = rows.reduce<ServiceRow | null>(
		(best, row) => (best === null || row.p95LatencyMs > best.p95LatencyMs ? row : best),
		null,
	)
	const failing = rows
		.filter((row) => row.errorRate > 0)
		.reduce<ServiceRow | null>(
			(worst, row) => (worst === null || row.errorRate > worst.errorRate ? row : worst),
			null,
		)
	return {
		serviceCount: new Set(rows.map((row) => row.serviceName)).size,
		slowest:
			slowest === null
				? null
				: { serviceName: slowest.serviceName, p95LatencyMs: slowest.p95LatencyMs },
		mostErrors:
			failing === null ? null : { serviceName: failing.serviceName, errorRate: failing.errorRate },
	}
}

export const LoadLiveFindings = Command.define("LoadOnboardingLiveFindings", {
	args: { timeZone: Schema.String },
	messages: [LiveMessage.LoadedFindings],
	execute: ({ timeZone }) =>
		currentWindow({ preset: "24h", snap: false, timeZone }).pipe(
			Effect.flatMap((window) => getServiceOverview({ data: window })),
			Effect.map((response) =>
				findingsOf(
					response.data.map((row) => ({
						serviceName: String(row.serviceName),
						p95LatencyMs: row.p95LatencyMs,
						errorRate: row.errorRate,
					})),
				),
			),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => LiveMessage.LoadedFindings({ result })),
		),
})

export const updateLive = (data: LiveData, message: LiveMessage): LiveData =>
	LiveMessage.match<LiveData>(message, {
		LoadedFindings: ({ result }) => AsyncData.settle(data, result),
	})
