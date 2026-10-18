import type { PlotLegendSeries } from "../../charts/plot-legend"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"
import type { ChartsLabArm } from "./arms"
import { AREA_TOKENS, CHROME_TOKENS, LINE_TOKENS } from "./spike-timeseries-tokens"

// The prototypes the lab host draws (`spike-host.ts`), by arm: the tokens each resolves, its
// accessible name and, for the legend arms, the series key under it.

export interface SpikeArm {
	readonly tokens: ReadonlyArray<string>
	readonly ariaLabel: string
	readonly legend?: Readonly<{ label: string; series: (theme: ThemeColors) => ReadonlyArray<PlotLegendSeries> }>
}

const series =
	(entries: ReadonlyArray<readonly [key: string, label: string, token: string]>) =>
	(theme: ThemeColors): ReadonlyArray<PlotLegendSeries> =>
		entries.map(([key, label, token]) => ({ key, label, color: resolveColor(theme, token) }))

const LATENCY = { tokens: [...LINE_TOKENS, ...CHROME_TOKENS], ariaLabel: "Latency percentiles" }
const VOLUME = { tokens: [...AREA_TOKENS, ...CHROME_TOKENS], ariaLabel: "Request volume" }

export const SPIKE_ARMS: Partial<Record<ChartsLabArm, SpikeArm>> = {
	"line-tanstack": LATENCY,
	"line-incomplete-tanstack": LATENCY,
	"line-legend-tanstack": {
		...LATENCY,
		legend: {
			label: "Latency percentiles",
			series: series([
				["p99", "P99", "--chart-p99"],
				["p95", "P95", "--chart-p95"],
				["p50", "P50", "--chart-p50"],
			]),
		},
	},
	"area-tanstack": VOLUME,
	"area-incomplete-tanstack": VOLUME,
	"area-legend-tanstack": {
		...VOLUME,
		legend: {
			label: "Request volume",
			series: series([
				["throughput", "Throughput", "--chart-throughput"],
				["errors", "Errors", "--chart-error"],
			]),
		},
	},
}

export const SPIKE_TOKENS_ALL: ReadonlyArray<string> = [
	...new Set(Object.values(SPIKE_ARMS).flatMap((arm) => arm?.tokens ?? [])),
]
