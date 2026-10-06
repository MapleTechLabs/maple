import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import {
	MetricsBrowse,
	MetricsBrowseFilters,
	MetricsViewToggle,
	type MetricsBrowsePatch,
} from "@/components/metrics/metrics-browse"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import {
	QUERY_BUILDER_METRIC_TYPES,
	type QueryBuilderMetricType,
	toQueryBuilderMetricType,
} from "@maple/query-model"

function asMetricType(value: string): QueryBuilderMetricType | undefined {
	return toQueryBuilderMetricType(value) ?? undefined
}

const metricsSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	type: Schema.optional(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	view: Schema.optional(Schema.Literals(["grid", "table"])),
	...TimeRangeSearchFields,
})

export type MetricsSearchParams = Schema.Schema.Type<typeof metricsSearchSchema>

export const Route = createFileRoute("/metrics/")({
	component: MetricsPage,
	validateSearch: Schema.toStandardSchemaV1(metricsSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

function MetricsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const handleTimeChange = (range: TimeRange) => {
		navigate({ search: (prev) => applyTimeRangeSearch(prev, range) })
	}

	const handlePatch = (patch: MetricsBrowsePatch) => {
		navigate({
			search: (prev) => ({
				...prev,
				...("q" in patch ? { q: patch.q || undefined } : undefined),
				...("type" in patch ? { type: patch.type } : undefined),
				...("view" in patch ? { view: patch.view === "grid" ? undefined : patch.view } : undefined),
			}),
			replace: true,
		})
	}

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Metrics" }]}
			titleContent={
				<MetricsBrowseFilters
					startTime={search.startTime}
					endTime={search.endTime}
					timePreset={search.timePreset}
					q={search.q ?? ""}
					type={search.type ?? null}
					onPatch={handlePatch}
				/>
			}
			headerActions={<MetricsViewToggle view={search.view ?? "grid"} onPatch={handlePatch} />}
			time={{ search, defaultPreset: "24h", onChange: handleTimeChange }}
		>
			<MetricsBrowse
				startTime={search.startTime}
				endTime={search.endTime}
				timePreset={search.timePreset}
				q={search.q ?? ""}
				type={search.type ?? null}
				view={search.view ?? "grid"}
				onPatch={handlePatch}
				onOpenMetric={(metric) => {
					navigate({
						to: "/metrics/$metricName",
						params: { metricName: metric.metricName },
						search: {
							startTime: search.startTime,
							endTime: search.endTime,
							timePreset: search.timePreset,
							type: asMetricType(metric.metricType),
						},
					})
				}}
			/>
		</DashboardPage>
	)
}
