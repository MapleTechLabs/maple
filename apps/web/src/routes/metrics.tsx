import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MetricsOverview } from "@/components/metrics/metrics-overview"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const metricsSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export type MetricsSearchParams = Schema.Schema.Type<typeof metricsSearchSchema>

export const Route = effectRoute(createFileRoute("/metrics"))({
	component: MetricsPage,
	validateSearch: Schema.toStandardSchemaV1(metricsSearchSchema),
})

function MetricsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const handleTimeChange = (range: { startTime?: string; endTime?: string; presetValue?: string }) => {
		navigate({ search: (prev) => applyTimeRangeSearch(prev, range) })
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<DashboardLayout
				breadcrumbs={[{ label: "Metrics" }]}
				title="Metrics"
				description="Explore and analyze OpenTelemetry metrics from your services."
				headerActions={
					<TimeRangeHeaderControls
						startTime={search.startTime}
						endTime={search.endTime}
						presetValue={search.timePreset ?? (search.startTime ? undefined : "24h")}
						defaultPreset="24h"
						onTimeChange={handleTimeChange}
					/>
				}
			>
				<MetricsOverview
					startTime={search.startTime}
					endTime={search.endTime}
					timePreset={search.timePreset}
				/>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}
