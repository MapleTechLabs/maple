import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { shortId } from "@maple/ui/lib/ids"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { LogsTable } from "@/components/logs/logs-table"
import { LogsVolumeChart } from "@/components/logs/logs-volume-chart"
import { LogsFilterSidebar } from "@/components/logs/logs-filter-sidebar"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
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
	...TimeRangeSearchFields,
})

export type LogsSearchParams = Schema.Schema.Type<typeof logsSearchSchema>

export const Route = createFileRoute("/logs/")({
	component: LogsPage,
	validateSearch: Schema.toStandardSchemaV1(logsSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

function LogsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const pinnedNamespace = useGlobalNamespace()

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
			time={{ search, defaultPreset: "12h", onChange: handleTimeChange }}
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
				<LogsTable filters={search} />
			</div>
		</DashboardPage>
	)
}
