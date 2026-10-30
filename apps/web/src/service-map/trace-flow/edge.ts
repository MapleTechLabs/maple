import { formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { getSmoothStepPath, Position } from "@xyflow/system"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { XY } from "../xyflow/geometry"
import type { FlowEdgeData } from "./flow-graph"

// `TraceFlowEdge` (packages/ui `traces/flow-edge.tsx`).

const LABEL_SHARE_THRESHOLD = 0.05

const strokeWidthForShare = (share: number): number => Math.min(4, 1.5 + 2.5 * Math.sqrt(Math.max(0, share)))

const formatShare = (share: number): string | undefined => {
	const pct = Math.round(share * 100)
	return pct >= 1 ? `${pct}%` : undefined
}

const labelContent = <M>(
	h: HtmlBuilder<M>,
	data: FlowEdgeData,
	hovered: boolean,
): ReadonlyArray<Html> | null => {
	const { isError, isMissing, share, count } = data
	if (!(hovered || isError || count > 1 || share >= LABEL_SHARE_THRESHOLD)) return null
	if (isMissing) return hovered ? [h.span([h.Class("italic text-muted-foreground/60")], ["no data"])] : null
	if (hovered) {
		const sharePct = formatShare(share)
		// Text runs stay split, so the DOM holds the same text nodes as the packages/ui flow edge.
		return [
			...(data.startOffsetMs !== undefined && data.startOffsetMs > 0
				? [h.span([h.Class(data.accentText)], ["+", formatDuration(data.startOffsetMs), " → "])]
				: []),
			h.span(isError ? [h.Class(cn(isError && "text-severity-error"))] : [], [
				formatDuration(data.durationMs),
			]),
			...(sharePct ? [h.span([], [" (", sharePct, ")"])] : []),
			...(count > 1
				? [
						h.span(
							[],
							[
								" ",
								"· ×",
								String(count),
								", ",
								formatDuration(data.minMs),
								"–",
								formatDuration(data.maxMs),
							],
						),
					]
				: []),
		]
	}
	if (isError) return [h.span([h.Class("text-severity-error")], [formatDuration(data.durationMs)])]
	if (count > 1) return [h.span([], ["×", String(count), " · ", formatDuration(data.durationMs)])]
	return [h.span([], [formatDuration(data.durationMs)])]
}

/** The edge's `<g>` children: stroke, wide hover target, and the duration pill. */
export const traceFlowEdge = <M>(
	h: HtmlBuilder<M>,
	source: XY,
	target: XY,
	data: FlowEdgeData,
	hovered: boolean,
	events: { readonly onEnter: M; readonly onLeave: M },
): ReadonlyArray<Html> => {
	const [path, labelX, labelY] = getSmoothStepPath({
		sourceX: source.x,
		sourceY: source.y,
		targetX: target.x,
		targetY: target.y,
		sourcePosition: Position.Bottom,
		targetPosition: Position.Top,
		borderRadius: 8,
	})
	const baseWidth = strokeWidthForShare(data.share)
	const label = labelContent(h, data, hovered)
	return [
		h.path([
			h.Class(cn(!data.isMissing && "react-flow__edge-path")),
			h.Attribute("d", path),
			h.Attribute("fill", "none"),
			h.Attribute("stroke", data.isError ? "var(--severity-error)" : "var(--flow-edge, var(--border))"),
			h.Attribute("stroke-width", String(hovered ? baseWidth + 0.5 : baseWidth)),
			...(data.isMissing ? [h.Attribute("stroke-dasharray", "4 4")] : []),
			h.Style({ transition: "stroke-width 150ms" }),
		]),
		h.path([
			h.Attribute("d", path),
			h.Attribute("fill", "none"),
			h.Attribute("stroke", "transparent"),
			h.Attribute("stroke-width", "16"),
			h.OnMouseEnter(events.onEnter),
			h.OnMouseLeave(events.onLeave),
		]),
		...(label === null
			? []
			: [
					h.foreignObject(
						[
							h.Attribute("x", String(labelX - 90)),
							h.Attribute("y", String(labelY + (target.y > source.y ? -16 : 4) - 12)),
							h.Attribute("width", "180"),
							h.Attribute("height", "24"),
							h.Class("pointer-events-none overflow-visible"),
						],
						[
							h.div(
								[h.Class("flex h-full items-center justify-center")],
								[
									h.span(
										[
											h.Class(
												"whitespace-nowrap rounded border border-border/60 bg-card/90 px-1.5 py-0.5 font-mono text-3xs tabular-nums text-muted-foreground backdrop-blur-sm",
											),
										],
										label,
									),
								],
							),
						],
					),
				]),
	]
}
