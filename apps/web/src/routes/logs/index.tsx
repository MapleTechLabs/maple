import { useNavigate, createFileRoute } from "@tanstack/react-router"
import type { DashboardRefreshIntervalSeconds } from "@maple/domain/http"
import * as React from "react"
import { shortId } from "@maple/ui/lib/ids"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { LogsLiveControls } from "@/components/logs/logs-live-controls"
import { LogsTable, type LogsInspectState, type LogsStreamHandle } from "@/components/logs/logs-table"
import { LogsVolumeChart } from "@/components/logs/logs-volume-chart"
import { LogsFilterSidebar } from "@/components/logs/logs-filter-sidebar"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { resolveSearchPreset } from "@/components/time-range-picker/time-range-header-controls"
import {
	dashboardViewParamsSchema,
	resolveRefreshIntervalSeconds,
} from "@/lib/dashboard-controls/search-params"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { logFilterChips } from "@/lib/logs/log-filter-chips"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"

const logsSearchSchema = Schema.Struct({
	services: OptionalStringArrayParam,
	severities: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	deploymentEnvMatchMode: Schema.optional(Schema.Literals(["contains"])),
	namespaces: OptionalStringArrayParam,
	namespaceMatchMode: Schema.optional(Schema.Literals(["contains"])),
	excludedServices: OptionalStringArrayParam,
	excludedSeverities: OptionalStringArrayParam,
	excludedDeploymentEnvs: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	// Attribute keys pinned as columns in the logs stream. Shareable via URL.
	columns: OptionalStringArrayParam,
	search: Schema.optional(Schema.String),
	// Scopes the stream to one trace. Set by pasting a trace ID into the search
	// box or following "View Logs" from a trace; cleared via its chip.
	traceId: Schema.optional(Schema.String),
	// Live tail cadence in seconds, same closed set and URL form as a dashboard's `?refresh=`.
	refresh: dashboardViewParamsSchema.refresh,
	...TimeRangeSearchFields,
})

export type LogsSearchParams = Schema.Schema.Type<typeof logsSearchSchema>

export const Route = createFileRoute("/logs/")({
	component: LogsPage,
	validateSearch: Schema.toStandardSchemaV1(logsSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const NOT_INSPECTING: LogsInspectState = { inspecting: false, scrolledAway: false }

function LogsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const pinnedNamespace = useGlobalNamespace()
	const [inspect, setInspect] = React.useState(NOT_INSPECTING)
	const streamRef = React.useRef<LogsStreamHandle>(null)

	// A custom range is a fixed window, so there is nothing new to tail: the cadence
	// is hidden and the URL keeps it for when a relative range comes back.
	const isCustomRange = resolveSearchPreset(search, "12h") === undefined
	const refreshSeconds = resolveRefreshIntervalSeconds(search.refresh, undefined)
	const handleRefreshChange = (next: DashboardRefreshIntervalSeconds) => {
		navigate({ replace: true, search: (prev) => ({ ...prev, refresh: next === 0 ? undefined : next }) })
	}

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const activeFilterChips = logFilterChips(search)
		// URL namespace filters are ignored while the org-global pin is on —
		// chips for them would suggest they still apply.
		.filter(
			(chip) =>
				pinnedNamespace === null ||
				(chip.param !== "namespaces" && chip.param !== "excludedNamespaces"),
		)
		.map((chip) => ({
			id: chip.param,
			label: chip.label,
			values: chip.values,
			negated: chip.negated,
			// The chip's tooltip still carries the full ID; the trace page itself
			// abbreviates to the same 8 characters.
			getValueLabel: chip.param === "traceId" ? (value: string) => shortId(value, "trace") : undefined,
			onRemove: () => navigate({ search: (prev) => ({ ...prev, [chip.param]: undefined }) }),
		}))

	const clearFacetFilters = () => {
		navigate({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(logFilterChips(prev).map((chip) => [chip.param, undefined])),
			}),
		})
	}

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Logs" }]}
			time={{
				search,
				defaultPreset: "12h",
				onChange: handleTimeChange,
				autoRefreshMs: isCustomRange ? 0 : refreshSeconds * 1000,
				autoRefreshPaused: inspect.inspecting,
				reloadControls: isCustomRange ? undefined : (
					<LogsLiveControls
						value={refreshSeconds}
						onChange={handleRefreshChange}
						inspect={inspect}
						onJumpToLatest={() => streamRef.current?.jumpToLatest()}
					/>
				),
			}}
			sticky={
				<LogsVolumeChart
					filters={search}
					onTimeRangeSelect={(range) =>
						handleTimeChange(
							{ startTime: range.startTime, endTime: range.endTime },
							{ replace: true },
						)
					}
				/>
			}
			filters={<LogsFilterSidebar />}
			// `fill`, not a scroll body: the logs stream is virtualized and owns its own
			// scroller, so an outer `overflow-auto` only adds a second scrollbar for the
			// wheel to chain into at the ends.
			fill
		>
			<div className="flex min-h-0 flex-1 flex-col p-4">
				<ActiveFilterChips chips={activeFilterChips} onClearAll={clearFacetFilters} />
				<LogsTable filters={search} onInspectingChange={setInspect} streamRef={streamRef} />
			</div>
		</DashboardPage>
	)
}
