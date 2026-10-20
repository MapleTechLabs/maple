import { AREA_CHART_TOKENS } from "../../../charts/area-chart"
import { BAR_CHART_TOKENS } from "../../../charts/bar-chart"
import { HEATMAP_TOKENS } from "../../../charts/heatmap-chart"
import { HISTOGRAM_BAR_TOKEN } from "../../../charts/histogram-chart"
import { SERVICE_CHART_TOKENS } from "./tiles-service"

// Every custom property a dashboard tile's canvas chart can resolve a colour from: the series
// palette (`resolveSeriesColors`' semantic tokens), the chart chrome, the heatmap ramps and the
// fixed-metric series. Literal colours (the identity palette) need no resolving.

const SEVERITY_TOKENS = ["trace", "debug", "info", "warn", "error", "fatal"].map(
	(level) => `var(--color-severity-${level})`,
)

export const WIDGET_CHART_TOKENS: ReadonlyArray<string> = [
	...new Set([
		...AREA_CHART_TOKENS,
		...BAR_CHART_TOKENS,
		...HEATMAP_TOKENS,
		...SERVICE_CHART_TOKENS,
		...SEVERITY_TOKENS,
		HISTOGRAM_BAR_TOKEN,
		"--foreground",
		"--destructive",
		"--chart-1",
		"var(--color-muted-foreground)",
		"var(--color-amber-500)",
		"var(--color-red-500)",
		"var(--color-emerald-500)",
	]),
]
