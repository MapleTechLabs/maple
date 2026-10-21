import { getSupabaseProjects, getSupabaseProjectTimeseries } from "@maple/web-data/warehouse/supabase-infra"
import { Effect } from "effect"
import { IntegrationStatuses } from "../../../data/integration-statuses"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import type { SupabaseProjectRow, SupabaseProjectTimeseriesRow } from "./model"

// The Supabase reads as Effects; each page wraps them in its own Commands.

export const loadSupabaseProjects = (window: TimeWindow) =>
	getSupabaseProjects({ data: window }).pipe(
		Effect.map((response): ReadonlyArray<SupabaseProjectRow> => response.projects),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** The status the sidebar and the integration card share (`IntegrationStatuses`). */
export const loadSupabaseStatus = (refresh: boolean) =>
	Effect.gen(function* () {
		const statuses = yield* IntegrationStatuses
		return yield* statuses.supabase({ refresh })
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const loadSupabaseTimeseries = (
	input: TimeWindow & { readonly projectRef: string; readonly bucketSeconds: number },
) =>
	getSupabaseProjectTimeseries({ data: { ...input } }).pipe(
		Effect.map((response): ReadonlyArray<SupabaseProjectTimeseriesRow> => response.buckets),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
