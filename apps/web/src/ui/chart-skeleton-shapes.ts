import type { Html, HtmlBuilder } from "foldkit/html"

// The heatmap, hbar, funnel, drop-off, paths, pie, gauge and stat ghosts of `ChartSkeleton`
// (packages/ui/src/components/charts/_shared/chart-skeleton.tsx), markup and numbers as there.

const STROKE = "var(--muted-foreground)"
const HEATMAP_COLS = 8
const HEATMAP_ROWS = 5

const attrs = <M>(h: HtmlBuilder<M>, entries: Readonly<Record<string, string | number>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, String(value)))

const stub = <M>(h: HtmlBuilder<M>, className: string, style?: Readonly<Record<string, string>>): Html =>
	h.div([h.Class(className), ...(style === undefined ? [] : [h.Style(style)])])

export const heatmapGhost = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[
			h.Class("grid h-full w-full gap-1 p-3"),
			h.Style({
				"grid-template-columns": `repeat(${HEATMAP_COLS},1fr)`,
				"grid-template-rows": `repeat(${HEATMAP_ROWS},1fr)`,
			}),
		],
		Array.from({ length: HEATMAP_COLS * HEATMAP_ROWS }, (_, i) =>
			stub(h, "rounded-sm bg-foreground/10 animate-pulse", {
				"animation-delay": `${-(Math.floor(i / HEATMAP_COLS) + (i % HEATMAP_COLS)) * 0.13}s`,
			}),
		),
	)

export const hbarGhost = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex h-full w-full flex-col justify-start gap-1.5 px-1")],
		[92, 78, 55, 34, 16].map((w, i) =>
			h.div(
				[
					h.Class("grid max-h-14 min-h-4.5 flex-1 items-center gap-2"),
					h.Style({ "grid-template-columns": "minmax(0, 38%) 1fr 44px" }),
				],
				[
					stub(h, "h-2.5 rounded-xs bg-foreground/10", { width: `${[72, 88, 60, 48, 66][i] ?? 0}%` }),
					h.div(
						[h.Class("h-3 overflow-hidden rounded-[3px] bg-foreground/5")],
						[
							stub(h, "h-full rounded-[3px] bg-foreground/10 animate-pulse", {
								width: `${w}%`,
								"animation-delay": `${-i * 0.13}s`,
							}),
						],
					),
					stub(h, "h-2.5 w-full rounded-xs bg-foreground/10"),
				],
			),
		),
	)

export const funnelGhost = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex h-full w-full flex-col justify-center gap-2 px-1")],
		[100, 64, 38, 18].map((w, i) =>
			h.div(
				[h.Class("flex flex-col gap-1")],
				[
					h.div(
						[h.Class("flex items-center justify-between")],
						[
							stub(h, "h-2.5 rounded-xs bg-foreground/10", { width: `${[26, 34, 22, 30][i] ?? 0}%` }),
							stub(h, "h-2.5 w-12 rounded-xs bg-foreground/10"),
						],
					),
					h.div(
						[h.Class("h-2.5 overflow-hidden rounded-[3px] bg-foreground/5")],
						[
							stub(h, "h-full rounded-[3px] bg-foreground/10 animate-pulse", {
								width: `${w}%`,
								"animation-delay": `${-i * 0.13}s`,
							}),
						],
					),
				],
			),
		),
	)

const PATH_COLUMNS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
	[[0, 92]],
	[
		[0, 54],
		[60, 76],
		[82, 92],
	],
	[
		[0, 32],
		[38, 54],
		[60, 70],
		[76, 82],
	],
	[
		[0, 22],
		[28, 40],
		[46, 54],
		[60, 66],
		[72, 76],
	],
]
const PATH_LINKS: ReadonlyArray<readonly [number, readonly [number, number], readonly [number, number]]> = [
	[0, [0, 54], [0, 54]],
	[0, [54, 70], [60, 76]],
	[0, [70, 80], [82, 92]],
	[1, [0, 32], [0, 32]],
	[1, [32, 48], [38, 54]],
	[1, [60, 70], [60, 70]],
	[1, [70, 76], [76, 82]],
	[1, [82, 92], [46, 54]],
	[2, [0, 22], [0, 22]],
	[2, [22, 32], [28, 40]],
	[2, [38, 46], [46, 54]],
	[2, [60, 66], [60, 66]],
	[2, [76, 82], [72, 76]],
]
const PATH_NODE_W = 1.4
const PATH_LABEL_W = 11
const PATH_LABEL_H = 2.6

export const pathsGhost = <M>(h: HtmlBuilder<M>): Html => {
	const columns = PATH_COLUMNS.length
	const nodeX = (column: number) => (column * (100 - PATH_NODE_W)) / (columns - 1)
	return h.div(
		[h.Class("flex h-full w-full flex-col")],
		[
			h.div(
				[h.Class("flex h-4.5 shrink-0 items-start justify-between")],
				PATH_COLUMNS.map(() => stub(h, "h-2 w-10 rounded-xs bg-foreground/10")),
			),
			h.svg(
				[...attrs(h, { viewBox: "0 0 100 100", preserveAspectRatio: "none" }), h.Class("min-h-0 w-full flex-1")],
				[
					...PATH_LINKS.map(([from, [sy0, sy1], [ty0, ty1]]) => {
						const x0 = nodeX(from) + PATH_NODE_W
						const x1 = nodeX(from + 1)
						const cx = (x0 + x1) / 2
						return h.path([
							...attrs(h, {
								d: `M${x0},${sy0} C${cx},${sy0} ${cx},${ty0} ${x1},${ty0} L${x1},${ty1} C${cx},${ty1} ${cx},${sy1} ${x0},${sy1} Z`,
								fill: STROKE,
								"fill-opacity": 0.08,
							}),
							h.Class("animate-pulse"),
							h.Style({ "animation-delay": `${-from * 0.2}s` }),
						])
					}),
					...PATH_COLUMNS.flatMap((column, i) => {
						const last = i === columns - 1
						const x = nodeX(i)
						return column.map(([y0, y1], j) =>
							h.g(
								[h.Class("animate-pulse"), h.Style({ "animation-delay": `${-(i + j) * 0.13}s` })],
								[
									h.rect(attrs(h, { x, y: y0, width: PATH_NODE_W, height: y1 - y0, fill: STROKE, "fill-opacity": 0.3 })),
									h.rect(
										attrs(h, {
											x: last ? x - 1.2 - PATH_LABEL_W : x + PATH_NODE_W + 1.2,
											y: y0 + 0.6,
											width: PATH_LABEL_W,
											height: PATH_LABEL_H,
											fill: STROKE,
											"fill-opacity": 0.18,
										}),
									),
								],
							),
						)
					}),
				],
			),
		],
	)
}

export const pieGhost = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(
		[...attrs(h, { viewBox: "0 0 100 100", preserveAspectRatio: "xMidYMid meet" }), h.Class("h-full max-h-[88%] w-full")],
		[
			h.circle(
				attrs(h, { cx: 50, cy: 50, r: 30, fill: "none", stroke: STROKE, "stroke-opacity": 0.12, "stroke-width": 16 }),
			),
			h.g(
				[h.Class("skeleton-spin")],
				[
					h.circle(
						attrs(h, {
							cx: 50,
							cy: 50,
							r: 30,
							fill: "none",
							stroke: STROKE,
							"stroke-opacity": 0.45,
							"stroke-width": 16,
							"stroke-linecap": "round",
							pathLength: 100,
							"stroke-dasharray": "26 74",
						}),
					),
				],
			),
		],
	)

const GAUGE_ARC = "M 26 79 A 34 34 0 1 1 74 79"

export const gaugeGhost = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(
		[...attrs(h, { viewBox: "0 0 100 100", preserveAspectRatio: "xMidYMid meet" }), h.Class("h-full w-full")],
		[
			h.path(
				attrs(h, {
					d: GAUGE_ARC,
					fill: "none",
					stroke: STROKE,
					"stroke-opacity": 0.12,
					"stroke-width": 9,
					"stroke-linecap": "round",
				}),
			),
			h.path([
				...attrs(h, {
					d: GAUGE_ARC,
					fill: "none",
					stroke: STROKE,
					"stroke-opacity": 0.55,
					"stroke-width": 9,
					"stroke-linecap": "round",
					pathLength: 100,
				}),
				h.Class("skeleton-draw"),
			]),
			h.rect([
				...attrs(h, { x: 36, y: 47, width: 28, height: 13, rx: 3, fill: STROKE, "fill-opacity": 0.12 }),
				h.Class("animate-pulse"),
			]),
		],
	)

export const statGhost = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex h-full w-full flex-col items-center justify-center gap-2.5")],
		[
			stub(h, "h-8 w-24 rounded-md bg-foreground/10 animate-pulse"),
			stub(h, "h-3 w-14 rounded-sm bg-foreground/10 animate-pulse", { "animation-delay": "0.2s" }),
		],
	)

const DROPOFF_HEIGHTS = [100, 44, 20, 8]

export const dropoffGhost = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex h-full w-full flex-col px-1")],
		[
			h.div([h.Class("flex justify-end pb-2")], [stub(h, "h-2.5 w-24 rounded-xs bg-foreground/10")]),
			h.div(
				[h.Class("grid min-h-0 flex-1 grid-cols-4 gap-3")],
				DROPOFF_HEIGHTS.map((height, i) => {
					const prev = i === 0 ? height : (DROPOFF_HEIGHTS[i - 1] ?? height)
					return h.div(
						[h.Class("flex min-w-0 flex-col")],
						[
							h.div(
								[h.Class("flex flex-col gap-1.5")],
								[
									stub(h, "h-2.5 rounded-xs bg-foreground/10", {
										width: `${[60, 72, 56, 64][i] ?? 0}%`,
									}),
									stub(h, "h-4 w-12 rounded-[3px] bg-foreground/15"),
									stub(h, "h-2.5 w-8 rounded-xs bg-foreground/10"),
								],
							),
							h.div(
								[h.Class("relative mt-2.5 min-h-0 flex-1")],
								[
									...(i > 0
										? [
												stub(h, "absolute inset-x-0 rounded-sm bg-foreground/[0.04]", {
													bottom: `${height}%`,
													height: `${prev - height}%`,
												}),
											]
										: []),
									stub(h, "absolute inset-x-0 bottom-0 rounded-sm bg-foreground/10 animate-pulse", {
										height: `${height}%`,
										"animation-delay": `${-i * 0.13}s`,
									}),
								],
							),
						],
					)
				}),
			),
		],
	)
