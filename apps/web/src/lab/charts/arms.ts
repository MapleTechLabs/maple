// The gallery's arms and card titles.

export const ARM_TITLES = {
	"pie-production": "Pie — production (PORTED: polar + radialArc; was hand-rolled SVG arcs)",
	"pie-tanstack": "Pie — TanStack (polar + pie + radialArc) · no hover affordance",
	"histogram-production": "Histogram — production (PORTED: binX + rect; was JS binning → string labels)",
	"histogram-tanstack": "Histogram — TanStack (binX + rect, numeric intervals)",
	"heatmap-production": "Heatmap — production (PORTED: cell + scaleBand; was CSS grid + layout solver)",
	"heatmap-tanstack": "Heatmap — TanStack (cell + scaleBand + sequential colour)",
	"line-production": "Line — production (PORTED: lineY per series; was recharts LineChart)",
	"line-tanstack": "Line — TanStack (lineY × 3, pinned point scale)",
	"area-production": "Area — production (PORTED: fill-only areaY + lineY; was recharts AreaChart)",
	"area-tanstack": "Area — TanStack (fill-only areaY + lineY, spec gradients)",
	"stacked-bar-production":
		"Stacked bar — production (PORTED: one barY, long-form z channel; was <Bar stackId> per service)",
	"stacked-bar-tanstack": "Stacked bar — TanStack (one barY, z channel + stack layout)",
	"line-incomplete-production":
		"Line + partial tail — production (PORTED: second mark over a slice; was twin _incomplete columns)",
	"line-incomplete-tanstack": "Line + partial tail — TanStack (second mark over a slice)",
	"area-incomplete-production":
		"Area + partial tail — production (PORTED: faded areaY + dashed lineY; was gradient + dashed <Line>)",
	"area-incomplete-tanstack": "Area + partial tail — TanStack (faded areaY + dashed lineY)",
	"stacked-bar-incomplete-tanstack":
		"Stacked bar + partial tail — NEW (barY strokeDasharray channel; recharts bars have no incomplete support at all)",
	"box-plot": "Box plot — NEW (boxY, Tukey summaries from raw observations)",
	"trace-scatter": "Trace scatter — NEW (hexbin over 5,000 spans, screen-space density)",
	sankey: "Service flow — NEW (sankeyDiagram, weighted by call volume)",
	treemap: "Span volume — NEW (hierarchy/treemap, service → operation)",
	"line-legend-tanstack":
		"Line + legend — TanStack (click a series to bring it forward; the axis never moves)",
	"area-legend-tanstack": "Area + legend — TanStack (per-mark fill/stroke opacity, one mark per series)",
	"stacked-bar-legend-tanstack":
		"Stacked bar + legend — TanStack (one mark, so emphasis is a muted FILL, not an opacity)",
	"stacked-bar-legend-scene-tanstack":
		"Stacked bar + legend — TanStack's OWN legend (interactiveColorLegend, zero DOM — but it can only HIDE, and on a stack that leaves a hole)",
	"pie-legend-tanstack":
		"Pie + stats legend — TanStack (hover grows the slice via onFocusChange + a second arc mark; click a row to pin it)",
	"pie-solid-tanstack": "Pie — TanStack (donut hole closed: innerRadius 0)",
	"pie-solid-legend-tanstack":
		"Pie + stats legend — TanStack (no hole; the hovered wedge grows from the centre out)",
	"treemap-legend":
		"Span volume + legend — NEW (leaves only, so colour IS the grouping; muting keeps the tiling fixed)",
	"sankey-legend":
		"Service flow + status key — NEW (bands, not series; picking one lifts those ribbons out of the wall)",
} as const

export type ChartsLabArm = keyof typeof ARM_TITLES

/** The gallery layout: sections of pairs and grids, in order. */
export const SECTIONS: ReadonlyArray<{
	readonly title: string
	readonly rows: ReadonlyArray<ReadonlyArray<ChartsLabArm>>
}> = [
	{
		title: "Consolidation — production beside its TanStack replacement",
		rows: [
			["pie-production", "pie-tanstack"],
			["histogram-production", "histogram-tanstack"],
			["heatmap-production", "heatmap-tanstack"],
			["line-production", "line-tanstack"],
			["area-production", "area-tanstack"],
			["stacked-bar-production", "stacked-bar-tanstack"],
		],
	},
	{
		title: "Trailing partial buckets — the dashed future segment",
		rows: [
			["line-incomplete-production", "line-incomplete-tanstack"],
			["area-incomplete-production", "area-incomplete-tanstack"],
			["stacked-bar-incomplete-tanstack"],
		],
	},
	{
		title: "Legends — production beside the TanStack series key",
		rows: [
			["line-production", "line-legend-tanstack"],
			["area-production", "area-legend-tanstack"],
			["stacked-bar-production", "stacked-bar-legend-tanstack"],
			["pie-production", "pie-legend-tanstack"],
			["stacked-bar-legend-tanstack", "stacked-bar-legend-scene-tanstack"],
			["pie-solid-tanstack", "pie-solid-legend-tanstack"],
			["treemap-legend", "sankey-legend"],
		],
	},
	{
		title: "Unlock — charts Maple cannot render today",
		rows: [["box-plot", "trace-scatter", "sankey", "treemap"]],
	},
]
