import type { PlotLegendSeries } from "../../charts/plot-legend"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"
import { type ChartsLabArm, SECTIONS } from "./arms"
import { FLOW_BANDS, FLOW_TOKENS } from "./spike-sankey-data"
import { serviceToken, TILE_TOKENS, TREEMAP_SERVICES } from "./spike-treemap-data"
import { heatmapPrunedNote, heatmapSpikeModel, HEATMAP_SPIKE_ROWS } from "./spike-heatmap-model"
import {
	AREA_TOKENS,
	CHROME_TOKENS,
	GROUT_TOKEN,
	LINE_TOKENS,
	RAMP_TOKENS,
	STACK_TOKEN_BY_SERVICE,
	STACK_TOKENS,
	type TokenWithFallback,
} from "./spike-timeseries-tokens"

// The prototypes the lab host draws (`spike-host.ts`), by arm: the tokens each resolves, its
// accessible name and, for the legend arms, the series key under it.

export interface SpikeArm {
	readonly tokens: ReadonlyArray<string | TokenWithFallback>
	readonly ariaLabel: string
	/** A note under the plot (`PlotFrame footer`). */
	readonly footer?: string
	readonly legend?: Readonly<{
		label: string
		series: (theme: ThemeColors) => ReadonlyArray<PlotLegendSeries>
	}>
}

const series =
	(entries: ReadonlyArray<readonly [key: string, label: string, token: string]>) =>
	(theme: ThemeColors): ReadonlyArray<PlotLegendSeries> =>
		entries.map(([key, label, token]) => ({ key, label, color: resolveColor(theme, token) }))

const LATENCY = { tokens: [...LINE_TOKENS, ...CHROME_TOKENS], ariaLabel: "Latency percentiles" }
const VOLUME = { tokens: [...AREA_TOKENS, ...CHROME_TOKENS], ariaLabel: "Request volume" }
const SPANS = { tokens: STACK_TOKENS, ariaLabel: "Spans by service" }

const ARMS = {
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
	"heatmap-tanstack": {
		tokens: [...RAMP_TOKENS.amber, GROUT_TOKEN, "--foreground"],
		ariaLabel: "Request count by hour and latency bucket",
		...((note) => (note === null ? {} : { footer: note }))(
			heatmapPrunedNote(heatmapSpikeModel(HEATMAP_SPIKE_ROWS)),
		),
	},
	"box-plot": { tokens: ["--chart-1"], ariaLabel: "Latency distribution by operation" },
	"trace-scatter": { tokens: RAMP_TOKENS.blues, ariaLabel: "Span duration by time, hex-binned by density" },
	sankey: { tokens: FLOW_TOKENS, ariaLabel: "Service call flow" },
	"sankey-legend": {
		tokens: FLOW_TOKENS,
		ariaLabel: "Service call flow",
		legend: {
			label: "Flow health",
			series: series(FLOW_BANDS.map((band) => [band.key, band.label, band.token] as const)),
		},
	},
	treemap: { tokens: TILE_TOKENS, ariaLabel: "Span volume by service and operation" },
	"treemap-legend": {
		tokens: TILE_TOKENS,
		ariaLabel: "Span volume by service and operation",
		legend: {
			label: "Span volume by service",
			series: series(
				TREEMAP_SERVICES.map((service) => [service, service, serviceToken(service)] as const),
			),
		},
	},
	"stacked-bar-tanstack": SPANS,
	"stacked-bar-incomplete-tanstack": SPANS,
	"stacked-bar-legend-scene-tanstack": SPANS,
	"stacked-bar-legend-tanstack": {
		...SPANS,
		legend: {
			label: "Spans by service",
			series: series(
				[...STACK_TOKEN_BY_SERVICE].map(([service, token]) => [service, service, token] as const),
			),
		},
	},
} satisfies Partial<Record<ChartsLabArm, SpikeArm>>

export const SPIKE_ARMS: ReadonlyMap<ChartsLabArm, SpikeArm> = new Map(
	Object.entries(ARMS).flatMap(([arm, spike]) => {
		const known = SECTIONS.flatMap((section) => section.rows.flat()).find(
			(candidate) => candidate === arm,
		)
		return known === undefined ? [] : [[known, spike] as const]
	}),
)

export const SPIKE_TOKENS_ALL: ReadonlyArray<string> = [
	...new Set(
		[...SPIKE_ARMS.values()].flatMap((arm) =>
			arm.tokens.map((token) => (typeof token === "string" ? token : token[0])),
		),
	),
]
