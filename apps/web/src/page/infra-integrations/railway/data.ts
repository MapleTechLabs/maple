import { getRailwayServices, getRailwayServiceTimeseries } from "@maple/web-data/warehouse/railway-infra"
import { Effect } from "effect"
import { IntegrationStatuses } from "../../../data/integration-statuses"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import type { RailwayServiceRow, RailwayServiceTimeseriesRow } from "./model"

// The Railway reads as Effects; each page wraps them in its own Commands (`railwayServicesResultAtom`,
// `railwayServiceTimeseriesResultAtom`, `railwayStatusAtom`).

export const loadRailwayServices = (window: TimeWindow) =>
	getRailwayServices({ data: window }).pipe(
		Effect.map((response): ReadonlyArray<RailwayServiceRow> => response.services),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const loadRailwayStatus = (refresh: boolean) =>
	Effect.gen(function* () {
		const statuses = yield* IntegrationStatuses
		return yield* statuses.railway({ refresh })
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const loadRailwayTimeseries = (
	input: TimeWindow & {
		readonly environmentId: string
		readonly serviceId: string
		readonly bucketSeconds: number
	},
) =>
	getRailwayServiceTimeseries({ data: { ...input } }).pipe(
		Effect.map((response): ReadonlyArray<RailwayServiceTimeseriesRow> => response.buckets),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
