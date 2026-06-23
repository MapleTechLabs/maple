import type { ReactNode } from "react"
import { ReferenceLine } from "recharts"

import type { ChartReferenceLine } from "./chart-types"

// Size of the interactive flag rendered at the top of a deploy/release marker.
const FLAG_WIDTH = 72
const FLAG_HEIGHT = 22

interface MarkerViewBox {
	x?: number
	y?: number
	width?: number
	height?: number
}

/**
 * Builds the recharts `label` content for a deploy marker: an HTML flag anchored
 * at the top of the vertical reference line. recharts renders chart internals as
 * SVG, so the flag is hosted in a `<foreignObject>` — that lets the host app drop
 * an interactive element (e.g. a commit hover card) onto the marker. recharts
 * calls this with the line's `viewBox` ({x, y, width, height} in pixels).
 */
function deployMarkerLabel(node: ReactNode) {
	return (props: { viewBox?: MarkerViewBox }) => {
		const vb = props.viewBox
		if (!vb || vb.x == null || vb.y == null) return <g />
		return (
			<foreignObject
				x={vb.x - FLAG_WIDTH / 2}
				y={vb.y + 1}
				width={FLAG_WIDTH}
				height={FLAG_HEIGHT}
				// The line itself shouldn't capture hover; only the flag (the inner div)
				// re-enables pointer events so the marker stays hoverable.
				style={{ overflow: "visible", pointerEvents: "none" }}
			>
				<div className="flex justify-center" style={{ width: FLAG_WIDTH, pointerEvents: "auto" }}>
					{node}
				</div>
			</foreignObject>
		)
	}
}

/**
 * Renders the release/deploy reference lines shared by the service charts.
 *
 * When `renderReferenceMarker` is provided, each line gets an interactive flag at
 * its top (the service detail page uses this to attach a commit hover card).
 * Without it, the lines render as bare dashed markers (the storybook / sample
 * usage and any chart that doesn't opt in).
 *
 * Returned as a plain array (not a component) so the `<ReferenceLine>` elements
 * stay direct children of the recharts chart, which introspects its children by
 * type — mirroring `thresholdReferenceLines`.
 */
export function renderReferenceLines(
	referenceLines: ChartReferenceLine[] | undefined,
	renderReferenceMarker?: (line: ChartReferenceLine) => ReactNode,
): ReactNode[] {
	if (!referenceLines || referenceLines.length === 0) return []

	return referenceLines.map((rl, i) => {
		const marker = renderReferenceMarker?.(rl)
		return (
			<ReferenceLine
				key={`release-${i}`}
				x={rl.x}
				stroke={rl.color ?? "var(--muted-foreground)"}
				strokeDasharray={rl.strokeDasharray ?? "6 4"}
				strokeWidth={1}
				label={marker ? deployMarkerLabel(marker) : undefined}
			/>
		)
	})
}
