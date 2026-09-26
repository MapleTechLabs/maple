import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { boundsKey, executeLocalCompiledFirstRow, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { TimeBounds } from "../lib/time"

export interface ErrorsFilters {
	/** Exact service name match. */
	service?: string
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Restrict to root-span errors. */
	rootOnly?: boolean
}

function sharedFilters(filters: ErrorsFilters) {
	return {
		services: filters.service ? [filters.service] : undefined,
		deploymentEnvs: filters.env ? [filters.env] : undefined,
	}
}

/** Headline stats for the errors view (error_events × service_usage). */
export function useLocalErrorsSummary(filters: ErrorsFilters, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "summary", filters, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<CH.ErrorsSummaryOutput | null> => {
			const row = await executeLocalCompiledFirstRow(
				CH.compile(
					CH.errorsSummaryQuery({ ...sharedFilters(filters), rootOnly: filters.rootOnly }),
					localParams(bounds),
				),
				signal,
			)
			return Option.getOrNull(row)
		},
	})
}

/** A fingerprint-grouped error type; `serviceNames` names up to three of its services. */
export type ErrorTypeRow = CH.ErrorsByTypeOutput

/** Fingerprint-grouped error types, most frequent first. */
export function useLocalErrorsByType(filters: ErrorsFilters, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "by-type", filters, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: ({ signal }): Promise<ReadonlyArray<ErrorTypeRow>> =>
			executeLocalCompiledQuery(
				CH.compile(
					CH.errorsByTypeQuery({
						...sharedFilters(filters),
						rootOnly: filters.rootOnly,
						limit: 50,
					}),
					localParams(bounds),
				),
				signal,
			),
	})
}

export interface ErrorsFacets {
	services: Array<{ name: string; count: number }>
	environments: Array<{ name: string; count: number }>
}

/**
 * Service + environment facets. Each section counts under the other filters
 * but not its own (the query drops a dimension's own filter from its branch).
 */
export function useLocalErrorsFacets(filters: ErrorsFilters, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "facets", filters, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<ErrorsFacets> => {
			const rows = await executeLocalCompiledQuery(
				CH.compileUnion(
					CH.errorsFacetsQuery({ ...sharedFilters(filters), rootOnly: filters.rootOnly }),
					localParams(bounds),
				),
				signal,
			)
			const pick = (facetType: string) =>
				rows
					.filter((r) => r.facetType === facetType)
					.map((r) => ({ name: r.name, count: Number(r.count) }))
			return { services: pick("service"), environments: pick("environment") }
		},
	})
}

/** Most recently errored traces for one fingerprint (expanded row), under the view's filters. */
export function useLocalErrorTraces(
	fingerprintHash: string | undefined,
	filters: ErrorsFilters,
	bounds: TimeBounds,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"traces",
			fingerprintHash,
			filters.rootOnly,
			filters.service,
			filters.env,
			boundsKey(bounds),
		],
		queryFn: fingerprintHash
			? ({ signal }): Promise<ReadonlyArray<CH.ErrorDetailTracesOutput>> =>
					executeLocalCompiledQuery(
						CH.compile(
							CH.errorDetailTracesQuery({
								fingerprintHash,
								rootOnly: filters.rootOnly,
								...sharedFilters(filters),
								limit: 10,
							}),
							localParams(bounds),
						),
						signal,
					)
			: skipToken,
	})
}
