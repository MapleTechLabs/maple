import type { ReactNode } from "react"
import { ReferenceLine } from "recharts"

import type { ChartReferenceLine } from "./chart-types"

// Fallback height for the marker box when recharts doesn't report the plot height
// (degrades the hitbox to roughly just the flag).
const FALLBACK_MARKER_HEIGHT = 22
// Width of the transparent box hosting the marker. Wide enough that the flag —
// centered on the line and potentially showing a commit message — isn't clipped
// by the SVG `<foreignObject>`. The box captures no pointer events; only the marker
// node (a narrow line hitbox + the flag) does.
const MARKER_BOX_WIDTH = 176

interface MarkerViewBox {
	x?: number
	y?: number
	width?: number
	height?: number
}

/**
 * Builds the recharts `label` content for a deploy marker. recharts renders chart
 * internals as SVG, so the marker is hosted in a `<foreignObject>` that spans the
 * FULL height of the vertical reference line — letting the host app drop a
 * full-line hover hitbox (with a flag at the top) onto the marker. recharts calls
 * this with the line's `viewBox` ({x, y, width, height} in pixels); for a vertical
 * line `x` is the line's pixel position and `height` is the plot height.
 */
function deployMarkerLabel(node: ReactNode) {
	return (props: { viewBox?: MarkerViewBox }) => {
		const vb = props.viewBox
		if (!vb || vb.x == null || vb.y == null) return <g />
		const height = vb.height && vb.height > 0 ? vb.height : FALLBACK_MARKER_HEIGHT
		return (
			<foreignObject
				x={vb.x - MARKER_BOX_WIDTH / 2}
				y={vb.y}
				width={MARKER_BOX_WIDTH}
				height={height}
				// The box itself shouldn't capture hover; only the marker node
				// re-enables pointer events (on the line hitbox + the flag).
				style={{ overflow: "visible", pointerEvents: "none" }}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "center",
						width: "100%",
						height: "100%",
						pointerEvents: "none",
					}}
				>
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
