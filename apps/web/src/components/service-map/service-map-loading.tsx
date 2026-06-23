import type { CSSProperties } from "react"

/**
 * Loading state for the service map.
 *
 * Rather than a generic spinner, this previews the destination: a ghost
 * topology that wires itself up. Nodes pop in, edges draw themselves between
 * them, and a pulse of "traffic" travels each link — looping. The vocabulary
 * (rounded-right cards with a left accent stripe + health dot, particle flow on
 * edges, the dotted canvas backdrop) mirrors the real map in
 * `service-map-node.tsx` / `service-map-edge.tsx` / `service-map-particles.tsx`.
 *
 * Self-contained inline SVG so it scales cleanly, themes via CSS variables, and
 * settles to a static graph under `prefers-reduced-motion` (gated in
 * `styles.css`).
 */

const VIEW_W = 520
const VIEW_H = 280
const NODE_W = 124
const NODE_H = 44
const RADIUS = 7

type GhostNode = {
	/** top-left corner in viewBox units */
	x: number
	y: number
	/** service-palette CSS variable for the accent stripe */
	color: string
	/** relative width of the name skeleton bar (0–1) */
	nameWidth: number
}

// A small, legible topology: an entry node on the left fanning out to mid-tier
// services and then to downstream dependencies. Colors are drawn from the same
// 16-color service palette the real map uses.
const NODES: GhostNode[] = [
	{ x: 20, y: 118, color: "var(--service-1)", nameWidth: 0.72 },
	{ x: 198, y: 40, color: "var(--service-6)", nameWidth: 0.6 },
	{ x: 198, y: 196, color: "var(--service-3)", nameWidth: 0.8 },
	{ x: 376, y: 86, color: "var(--service-11)", nameWidth: 0.54 },
	{ x: 376, y: 196, color: "var(--service-13)", nameWidth: 0.66 },
]

// Source → target index pairs. Edges leave a node's right edge and arrive at the
// next node's left edge, like the real left-to-right dependency flow.
const EDGES: ReadonlyArray<readonly [number, number]> = [
	[0, 1],
	[0, 2],
	[1, 3],
	[2, 3],
	[2, 4],
]

const anchor = (n: GhostNode, side: "right" | "left") => ({
	x: side === "right" ? n.x + NODE_W : n.x,
	y: n.y + NODE_H / 2,
})

/** Smooth S-curve between two anchor points (horizontal control handles). */
function edgePath(a: { x: number; y: number }, b: { x: number; y: number }) {
	const dx = Math.max(40, (b.x - a.x) * 0.5)
	return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`
}

/** Card outline with square left corners and rounded right corners (rounded-r-lg). */
function cardPath(x: number, y: number, w: number, h: number, r: number) {
	return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${
		x + w - r
	},${y + h} H${x} Z`
}

// Stand-in stroke width + intensity for the edge "tube" — the real map derives
// these from live traffic; during load we use a fixed moderate value.
const EDGE_SW = 3
const EDGE_INTENSITY = 0.55

export function ServiceMapLoading() {
	// Precompute edge geometry so the gradient defs and the tube layers share the
	// same anchor coordinates — the gradient runs source-color → target-color
	// along each link, exactly like the real map.
	const edges = EDGES.map(([from, to]) => {
		const a = anchor(NODES[from], "right")
		const b = anchor(NODES[to], "left")
		return {
			from,
			to,
			a,
			b,
			d: edgePath(a, b),
			gradientId: `sm-load-grad-${from}-${to}`,
			sourceColor: NODES[from].color,
			targetColor: NODES[to].color,
		}
	})

	return (
		<div className="service-map-loading flex h-full w-full flex-col items-center justify-center gap-6 px-6">
			<svg
				viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
				className="h-auto w-full max-w-[520px]"
				role="img"
				aria-label="Loading service map"
				fill="none"
			>
				<defs>
					{/* Faint dotted backdrop echoing the canvas grid (BackgroundVariant.Dots, gap 16) */}
					<pattern id="sm-load-grid" width="16" height="16" patternUnits="userSpaceOnUse">
						<circle cx="1" cy="1" r="1" fill="var(--muted-foreground)" opacity="0.06" />
					</pattern>
					{/* Per-edge source → target color gradient (matches service-map-edge.tsx) */}
					{edges.map((e) => (
						<linearGradient
							key={e.gradientId}
							id={e.gradientId}
							gradientUnits="userSpaceOnUse"
							x1={e.a.x}
							y1={e.a.y}
							x2={e.b.x}
							y2={e.b.y}
						>
							<stop offset="0%" style={{ stopColor: e.sourceColor } as CSSProperties} />
							<stop offset="100%" style={{ stopColor: e.targetColor } as CSSProperties} />
						</linearGradient>
					))}
				</defs>

				<rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="url(#sm-load-grid)" />

				{/* Edges — the real map's filter-free "tube": a wide ambient halo, a bright
				    outer wall, a hollow core matching the canvas, and a thin inner
				    highlight. Traffic flows as round particles (colored glow + white
				    core), mirroring service-map-particles.tsx. */}
				{edges.map((e, i) => {
					const stroke = `url(#${e.gradientId})`
					return (
						<g key={`edge-${e.from}-${e.to}`}>
							<g
								className="sm-load-edge"
								style={{ animationDelay: `${0.15 + i * 0.1}s` } as CSSProperties}
							>
								{/* Layer 0 — ambient halo */}
								<path
									d={e.d}
									stroke={stroke}
									strokeWidth={EDGE_SW * 3 + 12}
									strokeOpacity={0.03 + EDGE_INTENSITY * 0.05}
									strokeLinecap="round"
								/>
								{/* Layer 1 — outer wall (bright rim) */}
								<path
									d={e.d}
									stroke={stroke}
									strokeWidth={EDGE_SW + 4}
									strokeOpacity={0.12 + EDGE_INTENSITY * 0.15}
								/>
								{/* Layer 2 — hollow core matching the canvas background */}
								<path
									d={e.d}
									style={{ stroke: "var(--service-map-edge-core)" }}
									strokeWidth={EDGE_SW}
									strokeOpacity={0.5 + EDGE_INTENSITY * 0.2}
								/>
								{/* Layer 3 — thin inner highlight */}
								<path
									d={e.d}
									stroke={stroke}
									strokeWidth={Math.max(1, EDGE_SW * 0.4)}
									strokeOpacity={0.15 + EDGE_INTENSITY * 0.25}
								/>
							</g>
							{/* Flowing-traffic particle riding the link via CSS motion-path */}
							<g
								className="sm-load-particle"
								style={
									{
										offsetPath: `path("${e.d}")`,
										animationDelay: `${0.8 + i * 0.22}s`,
									} as CSSProperties
								}
							>
								<circle r={5} fill={e.sourceColor} opacity={0.22} />
								<circle r={1.6} fill="#ffffff" opacity={0.95} />
							</g>
						</g>
					)
				})}

				{/* Nodes — ghost service cards that pop in */}
				{NODES.map((n, i) => {
					const dotY = n.y + 13
					const nameY = n.y + 10
					const metricY = n.y + 28
					return (
						<g
							key={`node-${i}`}
							className="sm-load-node"
							style={{ animationDelay: `${i * 0.08}s` } as CSSProperties}
						>
							{/* Card body */}
							<path
								d={cardPath(n.x, n.y, NODE_W, NODE_H, RADIUS)}
								fill="var(--card)"
								stroke="var(--border)"
								strokeWidth={1}
							/>
							{/* Left accent stripe (3px), clipped to the card's left edge */}
							<rect x={n.x} y={n.y + 0.5} width={3} height={NODE_H - 1} fill={n.color} />
							{/* Health dot — green, breathing ("coming online") */}
							<circle
								className="sm-load-dot"
								cx={n.x + 13}
								cy={dotY}
								r={2.4}
								fill="var(--severity-info)"
								style={{ animationDelay: `${0.4 + i * 0.12}s` } as CSSProperties}
							/>
							{/* Service-name skeleton bar */}
							<rect
								x={n.x + 22}
								y={nameY}
								width={(NODE_W - 34) * n.nameWidth}
								height={4.5}
								rx={2.25}
								fill="var(--muted-foreground)"
								opacity={0.32}
							/>
							{/* Metric ticks */}
							{[0, 1, 2].map((m) => (
								<rect
									key={m}
									x={n.x + 13 + m * 30}
									y={metricY}
									width={20}
									height={3}
									rx={1.5}
									fill="var(--muted-foreground)"
									opacity={0.18}
								/>
							))}
						</g>
					)
				})}
			</svg>

			<div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
				<span>Mapping service connections</span>
				<span className="inline-flex" aria-hidden>
					<span className="pulse-dot">.</span>
					<span className="pulse-dot">.</span>
					<span className="pulse-dot">.</span>
				</span>
			</div>
		</div>
	)
}
