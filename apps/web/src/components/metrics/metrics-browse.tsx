import * as React from "react"

import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { GridIcon, MenuIcon } from "@/components/icons"
import { MetricsTypeFilter, type MetricType } from "./metrics-type-filter"
import { MetricsTable } from "./metrics-table"
import { MetricPreviewGrid } from "./metric-preview-grid"
import type { Metric } from "@/api/warehouse/metrics"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { SegmentedSelect, type SegmentedOption } from "@/components/common/segmented-select"

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

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2">
			<ToolbarSearch
				size="sm"
				className="w-64"
				placeholder="Search metrics..."
				query={q}
				onSearch={(next) => onPatch({ q: next })}
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
		<SegmentedSelect
			size="sm"
			aria-label="View"
			options={VIEW_OPTIONS}
			value={view}
			onChange={(next) => onPatch({ view: next })}
		/>
	)
}

const VIEW_OPTIONS: ReadonlyArray<SegmentedOption<MetricsBrowseView>> = [
	{ value: "grid", label: null, icon: <GridIcon size={14} />, ariaLabel: "Grid view" },
	{ value: "table", label: null, icon: <MenuIcon size={14} />, ariaLabel: "Table view" },
]

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
