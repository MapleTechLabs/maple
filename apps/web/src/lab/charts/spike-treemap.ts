import { muteColor } from "@maple/ui/components/plot/color-scale"
import { type ChartPoint, type ChartValue, defineChart } from "@tanstack/charts"
import { type TreemapNode, treemap } from "@tanstack/charts/hierarchy/treemap"
import { tooltip } from "@tanstack/charts/tooltip"
import { Option } from "effect"
import { ChartTooltip } from "../../charts/chart-spec"
import type { BuiltChart } from "../../charts/definitions/built-chart"
import { MUTED_COLOR_AMOUNT } from "../../charts/definitions/plot-constants"
import type { SpikeSpec } from "./spike-spec"
import { serviceToken, TREEMAP_ROWS, type TreemapRow } from "./spike-treemap-data"

// `TreemapSpike` / `TreemapLegendSpike`, definition
// half: span volume tiled service → operation, the legend muting by colour. Code copied.

const PATH_DELIMITER = "\u0000"
const MUTED_LABEL_AMOUNT = 0.45

const compactCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

type Node = TreemapNode<TreemapRow>

export const buildTreemapSpike = (spec: SpikeSpec): BuiltChart<Node, ChartValue, ChartValue> => {
	const color = (token: string) => spec.colors[token] ?? ""
	const background = color("--background")
	const baseColor = (service: string) => color(serviceToken(service))
	const highlighted = spec.highlighted
	const serviceColor =
		highlighted === null
			? baseColor
			: (service: string) =>
					service === highlighted
						? baseColor(service)
						: muteColor(baseColor(service), background, MUTED_COLOR_AMOUNT)
	const labelColorFor = (service: string) =>
		highlighted === null || service === highlighted
			? background
			: muteColor(baseColor(service), background, MUTED_LABEL_AMOUNT)
	const total = TREEMAP_ROWS.reduce((sum, row) => sum + row.spanCount, 0)
	const definition = defineChart({
		marks: [
			treemap(TREEMAP_ROWS, {
				path: (row: TreemapRow) => `${row.service}${PATH_DELIMITER}${row.operation}`,
				delimiter: PATH_DELIMITER,
				value: (row: TreemapRow) => row.spanCount,
				method: "squarify",
				paddingInner: 2,
				round: true,
				radius: 3,
				fill: (node) => serviceColor(node.data?.service ?? node.name),
				fillOpacity: 0.82,
				stroke: background,
				strokeWidth: 1,
				states: [
					{ when: { focus: "primary" }, style: { fillOpacity: 1 } },
					{ when: { focus: "unmatched" }, style: { fillOpacity: 0.45 } },
				],
				label: (node) => node.name,
				labelFill: (node) => labelColorFor(node.data?.service ?? node.name),
				labelFontSize: 10,
				labelFontWeight: 600,
				labelPadding: 6,
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
		focusKeyOf: (point) => point.datum.name,
		// Packed for the lab's body: the service, then the operation with its spans and share.
		tooltipOf: (points: ReadonlyArray<ChartPoint<Node, ChartValue, ChartValue>>) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (node) => {
				const service = node.data?.service ?? node.name
				const share = total === 0 ? 0 : node.value / total
				return ChartTooltip.Bucket({
					heading: service,
					rows: [
						{
							label: node.data?.operation ?? node.name,
							color: serviceColor(service),
							dashed: false,
							value: `${compactCount.format(node.value)} (${Math.round(share * 1000) / 10}%)`,
						},
					],
				})
			}),
	}
}
