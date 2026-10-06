import * as React from "react"

import { SearchInput } from "@maple/ui/components/ui/search-input"
import { GridIcon, MenuIcon } from "@/components/icons"
import { MetricsTypeFilter, type MetricType } from "./metrics-type-filter"
import { MetricsTable } from "./metrics-table"
import { MetricPreviewGrid } from "./metric-preview-grid"
import type { Metric } from "@/api/warehouse/metrics"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"

export type MetricsBrowseView = "grid" | "table"

export interface MetricsBrowsePatch {
	q?: string
	type?: MetricType
	view?: MetricsBrowseView
}

interface TimeWindowProps {
	startTime?: string
	endTime?: string
	timePreset?: string
}

const useBrowseTimeRange = ({ startTime, endTime, timePreset }: TimeWindowProps) =>
	useEffectiveTimeRange(startTime, endTime, timePreset ?? "24h")

/** Search and type pivot, rendered in the page header so the page has one control row. */
export function MetricsBrowseFilters({
	q,
	type,
	onPatch,
	...time
}: TimeWindowProps & {
	q: string
	type: MetricType | null
	onPatch: (patch: MetricsBrowsePatch) => void
}) {
	const { startTime, endTime } = useBrowseTimeRange(time)

	// Search input stays local while typing and commits to the URL after a
	// pause, so the atom query (and history) aren't churned per keystroke.
	const [localSearch, setLocalSearch] = React.useState(q)
	const commitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
	React.useEffect(() => {
		setLocalSearch(q)
	}, [q])
	React.useEffect(
		() => () => {
			if (commitTimer.current) clearTimeout(commitTimer.current)
		},
		[],
	)
	const handleSearchChange = (next: string) => {
		setLocalSearch(next)
		if (commitTimer.current) clearTimeout(commitTimer.current)
		commitTimer.current = setTimeout(() => onPatch({ q: next }), 300)
	}

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2">
			<SearchInput
				className="w-64"
				placeholder="Search metrics..."
				value={localSearch}
				onValueChange={handleSearchChange}
			/>
			<MetricsTypeFilter
				value={type}
				onChange={(nextType) => onPatch({ type: nextType ?? undefined })}
				startTime={startTime}
				endTime={endTime}
			/>
		</div>
	)
}

export function MetricsViewToggle({
	view,
	onPatch,
}: {
	view: MetricsBrowseView
	onPatch: (patch: MetricsBrowsePatch) => void
}) {
	return (
		<ToggleGroup
			variant="outline"
			size="sm"
			aria-label="View"
			value={[view]}
			onValueChange={(values) => {
				const next = values[0]
				if (next === "grid" || next === "table") onPatch({ view: next })
			}}
		>
			<ToggleGroupItem value="grid" aria-label="Grid view">
				<GridIcon size={14} />
			</ToggleGroupItem>
			<ToggleGroupItem value="table" aria-label="Table view">
				<MenuIcon size={14} />
			</ToggleGroupItem>
		</ToggleGroup>
	)
}

interface MetricsBrowseProps extends TimeWindowProps {
	q: string
	type: MetricType | null
	view: MetricsBrowseView
	onPatch: (patch: MetricsBrowsePatch) => void
	onOpenMetric: (metric: Metric) => void
}

export function MetricsBrowse({ q, type, view, onPatch, onOpenMetric, ...time }: MetricsBrowseProps) {
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useBrowseTimeRange(time)

	const deferredSearch = React.useDeferredValue(q)
	const handleClearFilters = () => onPatch({ q: "", type: undefined })

	return view === "grid" ? (
		<MetricPreviewGrid
			key={`${deferredSearch}|${type ?? ""}|${effectiveStartTime}|${effectiveEndTime}`}
			search={deferredSearch}
			metricType={type}
			startTime={effectiveStartTime}
			endTime={effectiveEndTime}
			onOpenMetric={onOpenMetric}
			onClearFilters={handleClearFilters}
		/>
	) : (
		<MetricsTable
			key={`${deferredSearch}|${type ?? ""}|${effectiveStartTime}|${effectiveEndTime}`}
			search={deferredSearch}
			metricType={type}
			onOpenMetric={onOpenMetric}
			onClearFilters={handleClearFilters}
			startTime={effectiveStartTime}
			endTime={effectiveEndTime}
		/>
	)
}
