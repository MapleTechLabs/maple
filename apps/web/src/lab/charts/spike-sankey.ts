import { muteColor } from "@maple/ui/components/plot/color-scale"
import { type ChartCurve, type ChartValue, defineChart } from "@tanstack/charts"
import { link } from "@tanstack/charts/link"
import {
	type SankeyLink,
	type SankeyNode as SankeyLayoutNode,
	sankeyDiagram,
} from "@tanstack/charts/network/sankey"
import { rect } from "@tanstack/charts/rect"
import { text } from "@tanstack/charts/text"
import { tooltip } from "@tanstack/charts/tooltip"
import { Option } from "effect"
import { ChartTooltip } from "../../charts/chart-spec"
import type { BuiltChart } from "../../charts/definitions/built-chart"
import { MUTED_COLOR_AMOUNT } from "../../charts/definitions/plot-constants"
import { FLOW_BANDS, SANKEY_EDGES, SANKEY_NODES, type SankeyEdge, type SankeyNode } from "./spike-sankey-data"
import { mutedOf, type SpikeSpec } from "./spike-spec"

// `SankeySpike` / `SankeyLegendSpike`, definition half:
// service call flow weighted by call volume, ribbons coloured by error band. Code copied.

const NODE_WIDTH = 14

const compactCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

/** A horizontal bump curve: each segment a cubic with both controls at the mid x. */
const bumpLine = (points: ReadonlyArray<readonly [number, number]>): string => {
	const [first, ...rest] = points
	if (first === undefined) return ""
	return rest.reduce(
		(acc, point) => {
			const midX = (acc.previous[0] + point[0]) / 2
			return {
				path: `${acc.path}C${midX},${acc.previous[1]},${midX},${point[1]},${point[0]},${point[1]}`,
				previous: point,
			}
		},
		{ path: `M${first[0]},${first[1]}`, previous: first },
	).path
}

const bumpX: ChartCurve = {
	line: (points) => bumpLine(points),
	area: (top, bottom) => {
		if (top.length === 0) return ""
		const back = [...bottom].reverse()
		return `${bumpLine(top)}${bumpLine(back).replace("M", "L")}Z`
	},
}

/** `bandForEdge`: the error band an edge's ribbon is coloured by. */
const bandForEdge = (edge: SankeyEdge): (typeof FLOW_BANDS)[number]["key"] => {
	const rate = edge.callCount === 0 ? 0 : edge.errorCount / edge.callCount
	return rate >= 0.05 ? "error" : rate >= 0.01 ? "warning" : "healthy"
}

/** Every listed node some edge touches, then any service only the edges name. */
const nodesOf = (edges: ReadonlyArray<SankeyEdge>): ReadonlyArray<SankeyNode> => {
	const listed = SANKEY_NODES.filter((node) =>
		edges.some((edge) => edge.sourceService === node.service || edge.targetService === node.service),
	)
	const extra = [...new Set(edges.flatMap((edge) => [edge.sourceService, edge.targetService]))]
		.filter((service) => !listed.some((node) => node.service === service))
		.map((service) => ({ service }))
	return [...listed, ...extra]
}

type Datum = SankeyLayoutNode<SankeyNode, SankeyEdge, string> | SankeyLink<SankeyNode, SankeyEdge, string>

/** The node's call total, or the link's calls and errors (packed for the lab's body). */
const tooltipOfDatum = (
	datum: Datum,
	nodeColor: string,
	strokeForEdge: (edge: SankeyEdge) => string,
): ChartTooltip => {
	if (datum.kind !== "link")
		return ChartTooltip.Bucket({
			heading: "",
			rows: [
				{
					label: datum.data.service,
					color: nodeColor,
					dashed: false,
					value: `${compactCount.format(datum.value)} calls`,
				},
			],
		})
	const edge = datum.data
	const rate = edge.callCount === 0 ? 0 : edge.errorCount / edge.callCount
	return ChartTooltip.Bucket({
		heading: `${edge.sourceService} → ${edge.targetService}`,
		rows: [
			{
				label: "calls",
				color: strokeForEdge(edge),
				dashed: false,
				value: compactCount.format(edge.callCount),
			},
			{
				label: "errors",
				color: strokeForEdge(edge),
				dashed: false,
				value: `${compactCount.format(edge.errorCount)} (${Math.round(rate * 1000) / 10}%)`,
			},
		],
	})
}

export const buildSankeySpike = (spec: SpikeSpec): BuiltChart<Datum, ChartValue, ChartValue> => {
	const color = (token: string) => spec.colors[token] ?? ""
	const muted = mutedOf(
		spec,
		FLOW_BANDS.map((band) => band.key),
	)
	const bandColor = (band: (typeof FLOW_BANDS)[number]["key"]) =>
		color(FLOW_BANDS.find((candidate) => candidate.key === band)?.token ?? "--chart-1")
	const strokeForEdge = (edge: SankeyEdge): string => {
		const band = bandForEdge(edge)
		return muted.has(band)
			? muteColor(bandColor(band), color("--background"), MUTED_COLOR_AMOUNT)
			: bandColor(band)
	}
	const definition = defineChart({
		marks: [
			sankeyDiagram({
				nodes: nodesOf(SANKEY_EDGES),
				links: SANKEY_EDGES,
				nodeKey: (node: SankeyNode) => node.service,
				source: (edge: SankeyEdge) => edge.sourceService,
				target: (edge: SankeyEdge) => edge.targetService,
				value: (edge: SankeyEdge) => edge.callCount,
				nodeWidth: NODE_WIDTH,
				nodePadding: 14,
				inset: { top: 8, right: 96, bottom: 8, left: 8 },
				nodeSort: null,
				marks: (context) => [
					link(context.links, {
						x1: (l) => l.x1,
						y1: (l) => l.y1,
						x2: (l) => l.x2,
						y2: (l) => l.y2,
						curve: bumpX,
						stroke: (l) => strokeForEdge(l.data),
						strokeWidth: (l) => Math.max(1, l.width),
						strokeOpacity: 0.38,
						lineCap: "butt",
						key: (l) => l.key,
					}),
					rect(context.nodes, {
						x1: (n) => n.x0,
						x2: (n) => n.x1,
						y1: (n) => n.y0,
						y2: (n) => n.y1,
						fill: color("--chart-2"),
						radius: 2,
						key: (n) => n.key,
						states: [
							{ when: { focus: "primary" }, style: { fillOpacity: 1 } },
							{ when: { focus: "unmatched" }, style: { fillOpacity: 0.4 } },
						],
					}),
					text(context.nodes, {
						x: (n) => n.x1 + 6,
						y: (n) => n.y,
						text: (n) => n.data.service,
						anchor: "start",
						fill: color("--foreground"),
						fontSize: 11,
						fontWeight: 500,
						dy: 4,
						key: (n) => n.key,
					}),
				],
			}),
		],
		scales: { x: null, y: null },
		guides: false,
		focus: "nearest",
		focusRing: false,
		tooltip: { use: tooltip, className: "maple-plot-tooltip" },
	})
	return {
		definition,
		focusKeyOf: (point) => String(point.datum.key),
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (datum) =>
				tooltipOfDatum(datum, color("--chart-2"), strokeForEdge),
			),
	}
}
