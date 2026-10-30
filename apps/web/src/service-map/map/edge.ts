import { getDbNodeColor } from "@maple/ui/components/service-map/service-map-db-style"
import {
	isDbNodeId,
	isNsAggregateId,
	NS_AGGREGATE_PREFIX,
	parseDbNodeId,
	type ServiceEdgeData,
} from "@maple/ui/components/service-map/service-map-utils"
import { getServiceColor, getValueHue } from "@maple/ui/lib/colors"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { getSmoothStepPath, Position } from "@xyflow/system"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { XY } from "../xyflow/geometry"

// `ServiceMapEdge` (packages/ui `service-map/service-map-edge.tsx`): filter-free SVG tubes.

const endpointColor = (nodeId: string): string => {
	if (isDbNodeId(nodeId)) {
		const { dbSystem, dbNamespace } = parseDbNodeId(nodeId)
		return getDbNodeColor(dbSystem, dbNamespace)
	}
	if (isNsAggregateId(nodeId)) {
		const ns = decodeURIComponent(nodeId.slice(NS_AGGREGATE_PREFIX.length))
		return `oklch(0.66 0.12 ${getValueHue(ns) ?? 0})`
	}
	return getServiceColor(nodeId)
}

export const edgeStrokeWidth = (callCount: number): number =>
	callCount <= 0 ? 2 : Math.min(8, Math.max(2, 2 + Math.log10(callCount) * 2))

const edgeIntensity = (callsPerSecond: number): number =>
	callsPerSecond <= 0 ? 0.15 : Math.min(1, 0.3 + 0.7 * (Math.log10(1 + callsPerSecond) / Math.log10(100)))

/** Geometry the particle canvas animates along: the path, colour and rate of one edge. */
export interface EdgeGeometry {
	readonly path: string
	readonly sourceColor: string
	readonly callsPerSecond: number
	readonly strokeWidth: number
}

export const edgeGeometry = (
	edge: { readonly source: string; readonly data: ServiceEdgeData | undefined },
	source: XY,
	target: XY,
): EdgeGeometry & { readonly labelX: number; readonly labelY: number } => {
	const [path, labelX, labelY] = getSmoothStepPath({
		sourceX: source.x,
		sourceY: source.y,
		targetX: target.x,
		targetY: target.y,
		sourcePosition: Position.Right,
		targetPosition: Position.Left,
		borderRadius: 12,
	})
	const dimmed = edge.data?.dimmed === true
	return {
		path,
		labelX,
		labelY,
		sourceColor: endpointColor(edge.source),
		callsPerSecond: dimmed ? 0 : (edge.data?.callsPerSecond ?? 0),
		strokeWidth: edgeStrokeWidth(edge.data?.callCount ?? 0),
	}
}

const gradient = <M>(h: HtmlBuilder<M>, id: string, source: XY, target: XY, from: string, to: string): Html =>
	h.defs(
		[],
		[
			h.linearGradient(
				[
					h.Id(id),
					h.Attribute("gradientUnits", "userSpaceOnUse"),
					h.Attribute("x1", String(source.x)),
					h.Attribute("y1", String(source.y)),
					h.Attribute("x2", String(target.x)),
					h.Attribute("y2", String(target.y)),
				],
				[
					h.stop([h.Attribute("offset", "0%"), h.Attribute("stop-color", from)]),
					h.stop([h.Attribute("offset", "100%"), h.Attribute("stop-color", to)]),
				],
			),
		],
	)

const tubePath = <M>(
	h: HtmlBuilder<M>,
	d: string,
	attributes: ReadonlyArray<readonly [string, string]>,
): Html =>
	h.path([
		h.Attribute("d", d),
		h.Attribute("fill", "none"),
		...attributes.map(([name, value]) => h.Attribute(name, value)),
	])

const edgeLabel = <M>(h: HtmlBuilder<M>, data: ServiceEdgeData | undefined, x: number, y: number): Html => {
	const callCount = data?.callCount ?? 0
	const hasSampling = data?.hasSampling ?? false
	const errorRate = data?.errorRate ?? 0
	const estimated = hasSampling
		? Math.round(
				(data?.estimatedCallsPerSecond ?? 0) *
					(callCount / Math.max(data?.callsPerSecond ?? 1, 0.001)),
			)
		: callCount
	return h.foreignObject(
		[
			h.Attribute("x", String(x - 40)),
			h.Attribute("y", String(y)),
			h.Attribute("width", "80"),
			h.Attribute("height", "24"),
			h.Class("overflow-visible pointer-events-none"),
		],
		[
			h.div(
				[
					h.Class("flex items-center justify-center"),
					...(hasSampling
						? [
								h.Title(
									"Based on traced requests. Actual rate may be higher with sampling enabled",
								),
							]
						: []),
				],
				[
					h.span(
						[
							h.Class(
								"rounded-sm bg-card/90 px-1.5 py-0.5 text-3xs font-mono font-medium text-muted-foreground border border-border-subtle whitespace-nowrap tabular-nums",
							),
						],
						[
							...(hasSampling ? ["~"] : []),
							formatNumber(hasSampling ? estimated : callCount),
							...(errorRate > 0
								? [
										h.span(
											[h.Class(errorRateClass(errorRate, { neutral: "" }))],
											[" ", formatErrorRate(errorRate)],
										),
									]
								: []),
						],
					),
				],
			),
		],
	)
}

/** The edge's `<g>` children; `index` keeps gradient ids unique. */
export const serviceMapEdge = <M>(
	h: HtmlBuilder<M>,
	edge: {
		readonly id: string
		readonly source: string
		readonly target: string
		readonly data: ServiceEdgeData | undefined
	},
	source: XY,
	target: XY,
	index: number,
): ReadonlyArray<Html> => {
	const data = edge.data
	const geometry = edgeGeometry(edge, source, target)
	const targetColor = endpointColor(edge.target)
	const dimmed = data?.dimmed === true
	const i = dimmed ? 0 : edgeIntensity(data?.callsPerSecond ?? 0)
	const dim = dimmed ? 0.18 : 1
	const sw = geometry.strokeWidth
	const gradientId = `grad-${edge.id}-${index}`.replace(/[^a-zA-Z0-9-_]/g, "_")
	const stroke = `url(#${gradientId})`
	const defs = gradient(h, gradientId, source, target, geometry.sourceColor, targetColor)
	if (data?.relation !== undefined) {
		return [
			defs,
			h.path([
				h.Attribute("d", geometry.path),
				h.Attribute("fill", "none"),
				h.Attribute("stroke", stroke),
				h.Attribute("stroke-width", "1.5"),
				h.Attribute("stroke-opacity", String(0.55 * dim)),
				h.Attribute("stroke-dasharray", "4 4"),
				h.Attribute("stroke-linecap", "round"),
				h.Class("react-flow__edge-path"),
			]),
		]
	}
	return [
		defs,
		tubePath(h, geometry.path, [
			["stroke", stroke],
			["stroke-width", String(sw * 3 + 12)],
			["stroke-opacity", String((0.03 + i * 0.05) * dim)],
			["stroke-linecap", "round"],
		]),
		tubePath(h, geometry.path, [
			["stroke", stroke],
			["stroke-width", String(sw + 4)],
			["stroke-opacity", String((0.12 + i * 0.15) * dim)],
		]),
		h.path([
			h.Attribute("d", geometry.path),
			h.Attribute("fill", "none"),
			h.Style({ stroke: "var(--service-map-edge-core, var(--background))" }),
			h.Attribute("stroke-width", String(sw)),
			h.Attribute("stroke-opacity", String((0.5 + i * 0.2) * dim)),
			h.Class("react-flow__edge-path"),
		]),
		tubePath(h, geometry.path, [
			["stroke", stroke],
			["stroke-width", String(Math.max(1, sw * 0.4))],
			["stroke-opacity", String((0.15 + i * 0.25) * dim)],
		]),
		...(dimmed
			? []
			: [edgeLabel(h, data, geometry.labelX, geometry.labelY + (target.y > source.y ? -16 : 4) - 12)]),
	]
}
