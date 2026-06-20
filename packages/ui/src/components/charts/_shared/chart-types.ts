import type React from "react"

export type ChartLegendMode = "visible" | "hidden" | "right"
export type ChartTooltipMode = "visible" | "hidden"

export interface ChartReferenceLine {
	x: string
	label?: string
	color?: string
	strokeDasharray?: string
	/**
	 * The full commit SHA this marker represents, when it stands for a release.
	 * `label` is the short (display) form; this carries the resolvable handle the
	 * host app needs to render a commit hover card via `renderReferenceMarker`.
	 */
	sha?: string
}

export interface ChartThreshold {
	value: number
	color: string
	label?: string
}

export interface BaseChartProps {
	data?: Record<string, unknown>[]
	className?: string
	legend?: ChartLegendMode
	/** When true, the legend block includes the per-series Min/Max/Mean/Last table. */
	seriesStats?: boolean
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
	stacked?: boolean
	curveType?: "linear" | "monotone"
	referenceLines?: ChartReferenceLine[]
	/**
	 * Optional render-prop for an interactive marker at the top of each reference
	 * line (a deploy/release flag). Kept as a callback so the design-system package
	 * stays free of app-specific data fetching — the service detail page passes a
	 * commit hover card here. When omitted, reference lines render as bare markers.
	 */
	renderReferenceMarker?: (line: ChartReferenceLine) => React.ReactNode
	/**
	 * Horizontal threshold lines drawn across the y-axis. Used to mark
	 * "danger zone" values on time-series charts.
	 */
	thresholds?: ChartThreshold[]
	unit?: string
	/**
	 * IANA timezone for all x-axis time labels/tooltips (and the deploy-marker
	 * time in the tooltip). Defaults to the browser zone when omitted.
	 */
	timeZone?: string
	logScale?: boolean
	softMin?: number
	softMax?: number
	/**
	 * When true, the y-axis lower bound follows the minimum of the displayed
	 * data (with padding) instead of being pinned at zero. Ignored when
	 * `softMin` or `logScale` are set. Applies to line/area charts.
	 */
	fitYAxisToData?: boolean
	showPoints?: boolean
	/**
	 * Synchronizes hover state across charts that share the same id.
	 * Pass the same id to every chart in a dashboard / detail page so the
	 * tooltip cursor lines up to the same time bucket on hover.
	 */
	syncId?: string
	/**
	 * Enables "drag to zoom" on time-series charts: the user drags across the
	 * plot to select a window, and on release this fires with the bucket
	 * timestamps (the chart's `bucket` x-values) at each end, ordered ascending.
	 * The host converts these to a time range. When omitted, drag-zoom is off.
	 */
	onZoomSelect?: (range: { startBucket: string; endBucket: string }) => void
	pie?: {
		donut?: boolean
		innerRadius?: number
		showLabels?: boolean
		showPercent?: boolean
	}
	histogram?: {
		bucketCount?: number
		bucketWidth?: number
		logScaleY?: boolean
	}
	heatmap?: {
		colorScale?: "viridis" | "magma" | "cividis" | "blues" | "reds"
		scaleType?: "linear" | "log"
	}
	funnel?: {
		showStepPercent?: boolean
	}
}

export type ChartCategory = "bar" | "area" | "line" | "pie" | "histogram" | "heatmap" | "funnel"

export interface ChartRegistryEntry {
	id: string
	name: string
	description: string
	category: ChartCategory
	component: React.LazyExoticComponent<React.ComponentType<BaseChartProps>>
	sampleData: Record<string, unknown>[]
	tags: string[]
}
