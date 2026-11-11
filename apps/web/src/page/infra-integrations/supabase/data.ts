import { getSupabaseProjects, getSupabaseProjectTimeseries } from "@maple/web-data/warehouse/supabase-infra"
import {
	getSupabaseApiTopPaths,
	getSupabaseApiTraffic,
	getSupabaseLogIssues,
	getSupabaseProjectCallers,
	getSupabaseProjectInsights,
} from "@maple/web-data/warehouse/supabase-insights"
import { Effect, Result, Array as Arr } from "effect"
import { IntegrationStatuses } from "../../../data/integration-statuses"
import { settled } from "@maple/views/data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import type { SupabaseFleetInsights, SupabaseProjectRow, SupabaseProjectTimeseriesRow } from "./model"

// The Supabase reads as Effects; each page wraps them in its own Commands.

type ProjectWindow = TimeWindow & { readonly projectRef: string }
type BucketedProjectWindow = ProjectWindow & { readonly bucketSeconds: number }

export const loadSupabaseProjects = (window: TimeWindow) =>
	getSupabaseProjects({ data: window }).pipe(
		Effect.map((response): ReadonlyArray<SupabaseProjectRow> => response.projects),
		settled,
	)

/** The status the sidebar and the integration card share (`IntegrationStatuses`). */
export const loadSupabaseStatus = (refresh: boolean) =>
	Effect.gen(function* () {
		const statuses = yield* IntegrationStatuses
		return yield* statuses.supabase({ refresh })
	}).pipe(settled)

export const loadSupabaseTimeseries = (input: BucketedProjectWindow) =>
	getSupabaseProjectTimeseries({ data: { ...input } }).pipe(
		Effect.map((response): ReadonlyArray<SupabaseProjectTimeseriesRow> => response.buckets),
		settled,
	)

export const loadSupabaseApiTraffic = (input: BucketedProjectWindow) =>
	getSupabaseApiTraffic({ data: { ...input } }).pipe(settled)

export const loadSupabaseApiTopPaths = (input: ProjectWindow) =>
	getSupabaseApiTopPaths({ data: { ...input } }).pipe(settled)

export const loadSupabaseCallers = (input: BucketedProjectWindow) =>
	getSupabaseProjectCallers({ data: { ...input } }).pipe(settled)

/** One project's recurring WARN+ log messages, or every project's without a ref. */
export const loadSupabaseLogIssues = (input: TimeWindow & { readonly projectRef?: string }) =>
	getSupabaseLogIssues({ data: { ...input } }).pipe(settled)

export const loadSupabaseInsights = (projectRef: string) =>
	getSupabaseProjectInsights({ data: { projectRef } }).pipe(settled)

/** Most projects the overview reads advisors for. */
export const FLEET_INSIGHTS_LIMIT = 10

/** Each project's insights, concurrently; a project whose read fails is listed, not fatal. */
export const loadSupabaseFleetInsights = (refs: ReadonlyArray<string>) =>
	Effect.forEach(
		refs.slice(0, FLEET_INSIGHTS_LIMIT),
		(ref) => Effect.map(loadSupabaseInsights(ref), (result) => ({ ref, result })),
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map((reads): SupabaseFleetInsights => ({
			insights: Arr.flatMap(reads, ({ result }) => (Result.isSuccess(result) ? [result.success] : [])),
			failedRefs: Arr.flatMap(reads, ({ ref, result }) => (Result.isFailure(result) ? [ref] : [])),
		})),
	)
