import { CH } from "@maple/query-engine"
import type { TimeBounds } from "../../lib/time"
import { Effect, Option, Schema } from "effect"
import { localParams, queryFirstRow, queryRows } from "../../data/local-query"

// The Errors page's queries.

export interface ErrorsFilters {
	readonly service?: string
	readonly env?: string
	readonly rootOnly?: boolean
}

const sharedFilters = (filters: ErrorsFilters) => ({
	services: filters.service ? [filters.service] : undefined,
	deploymentEnvs: filters.env ? [filters.env] : undefined,
})

export const ErrorsSummary = Schema.Struct({
	totalErrors: Schema.Number,
	errorRate: Schema.Number,
	affectedTracesCount: Schema.Number,
})
export type ErrorsSummary = typeof ErrorsSummary.Type

export const ErrorTypeRow = Schema.Struct({
	fingerprintHash: Schema.String,
	errorLabel: Schema.String,
	sampleMessage: Schema.String,
	count: Schema.Number,
	affectedServicesCount: Schema.Number,
	serviceNames: Schema.Array(Schema.String),
	lastSeen: Schema.DateTimeUtc,
})
export type ErrorTypeRow = typeof ErrorTypeRow.Type

export const FacetOption = Schema.Struct({ name: Schema.String, count: Schema.Number })

export const ErrorsFacets = Schema.Struct({
	services: Schema.Array(FacetOption),
	environments: Schema.Array(FacetOption),
})
export type ErrorsFacets = typeof ErrorsFacets.Type

export const ErrorTrace = Schema.Struct({
	traceId: Schema.String,
	startTime: Schema.DateTimeUtc,
	durationMicros: Schema.Number,
	spanCount: Schema.Number,
	rootSpanName: Schema.String,
	errorSpanId: Schema.String,
	errorSpanName: Schema.String,
	errorServiceName: Schema.String,
})
export type ErrorTrace = typeof ErrorTrace.Type

/** The headline stats (error_events and service_usage). */
export const fetchErrorsSummary = (filters: ErrorsFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryFirstRow(
			CH.compile(
				CH.errorsSummaryQuery({ ...sharedFilters(filters), rootOnly: filters.rootOnly }),
				localParams(bounds),
			),
			apiBase,
		),
		(row): ErrorsSummary | null =>
			Option.match(row, {
				onNone: () => null,
				onSome: (found) => ({
					totalErrors: found.totalErrors,
					errorRate: found.errorRate,
					affectedTracesCount: found.affectedTracesCount,
				}),
			}),
	)

/** Fingerprint-grouped error types, most frequent first. */
export const fetchErrorsByType = (filters: ErrorsFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.errorsByTypeQuery({ ...sharedFilters(filters), rootOnly: filters.rootOnly, limit: 50 }),
				localParams(bounds),
			),
			apiBase,
		),
		(rows): ReadonlyArray<ErrorTypeRow> =>
			rows.map((row) => ({
				fingerprintHash: row.fingerprintHash,
				errorLabel: row.errorLabel,
				sampleMessage: row.sampleMessage,
				count: row.count,
				affectedServicesCount: row.affectedServicesCount,
				serviceNames: row.serviceNames,
				lastSeen: row.lastSeen,
			})),
	)

/** Facets: each section counts under the other filters but not its own. */
export const fetchErrorsFacets = (filters: ErrorsFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compileUnion(
				CH.errorsFacetsQuery({ ...sharedFilters(filters), rootOnly: filters.rootOnly }),
				localParams(bounds),
			),
			apiBase,
		),
		(rows): ErrorsFacets => {
			const pick = (facetType: string) =>
				rows.filter((r) => r.facetType === facetType).map((r) => ({ name: r.name, count: r.count }))
			return { services: pick("service"), environments: pick("environment") }
		},
	)

/** The most recently errored traces of one fingerprint. */
export const fetchErrorTraces = (
	fingerprintHash: string,
	filters: ErrorsFilters,
	bounds: TimeBounds,
	apiBase: string,
) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.errorDetailTracesQuery({
					fingerprintHash,
					rootOnly: filters.rootOnly,
					...sharedFilters(filters),
					limit: 10,
				}),
				localParams(bounds),
			),
			apiBase,
		),
		(rows): ReadonlyArray<ErrorTrace> =>
			rows.map((row) => ({
				traceId: row.traceId,
				startTime: row.startTime,
				durationMicros: row.durationMicros,
				spanCount: row.spanCount,
				rootSpanName: row.rootSpanName,
				errorSpanId: row.errorSpanId,
				errorSpanName: row.errorSpanName,
				errorServiceName: row.errorServiceName,
			})),
	)
