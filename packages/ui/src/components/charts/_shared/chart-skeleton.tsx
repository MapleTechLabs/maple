import { cn } from "../../../lib/utils"
import type { ChartCategory } from "./chart-types"

export type ChartSkeletonVariant = ChartCategory | "funnel-dropoff" | "gauge" | "stat"

interface ChartSkeletonProps {
	/** Picks which ghost shape to draw — usually the registry entry's category. */
	variant: ChartSkeletonVariant
	className?: string
}

const STROKE = "var(--muted-foreground)"

/** Wavy ghost path shared by the line + area variants. */
const TREND = "M 2 72 L 20 52 L 38 64 L 56 30 L 74 46 L 98 16"

function GridLines() {
	return (
		<>
			{[28, 52, 76].map((y) => (
				<line
					key={y}
					x1={0}
					y1={y}
					x2={100}
					y2={y}
					stroke={STROKE}
					strokeOpacity={0.12}
					strokeWidth={1}
					vectorEffect="non-scaling-stroke"
				/>
			))}
		</>
	)
}

function TrendLine() {
	return (
		<path
			d={TREND}
			fill="none"
			stroke={STROKE}
			strokeOpacity={0.55}
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			vectorEffect="non-scaling-stroke"
			pathLength={100}
			className="skeleton-draw"
		/>
	)
}

/** Vertical bars whose heights rise and fall in a staggered wave. */
function Bars({ heights, delay }: { heights: number[]; delay: (i: number) => number }) {
	return (
		<>
			{heights.map((h, i) => (
				<div
					key={i}
					className="flex-1 rounded-[2px] bg-foreground/10 skeleton-bar"
					style={{ height: `${h}%`, animationDelay: `${delay(i)}s` }}
				/>
			))}
		</>
	)
}

const BAR_HEIGHTS = [46, 70, 34, 86, 56, 96, 62]

// The paths ghost: four node columns joined by ribbons, in the shape the real
// flow draws — the anchor on the left, the columns thinning to the right.
// Node spans are percentages of the plot height; ribbons run between them.
const PATH_COLUMNS: ReadonlyArray<ReadonlyArray<[number, number]>> = [
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
/** [from column, source span, target span] — spans in plot-height percent. */
const PATH_LINKS: ReadonlyArray<[number, [number, number], [number, number]]> = [
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
/** Node width and label stub size, in percent of the plot (the ghost is drawn unscaled). */
const PATH_NODE_W = 1.4
const PATH_LABEL_W = 11
const PATH_LABEL_H = 2.6

function PathsGhost() {
	const columns = PATH_COLUMNS.length
	const nodeX = (column: number) => (column * (100 - PATH_NODE_W)) / (columns - 1)
	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex h-[18px] shrink-0 items-start justify-between">
				{PATH_COLUMNS.map((_, i) => (
					<div key={i} className="h-2 w-10 rounded-[2px] bg-foreground/10" />
				))}
			</div>
			<svg viewBox="0 0 100 100" preserveAspectRatio="none" className="min-h-0 w-full flex-1">
				{PATH_LINKS.map(([from, [sy0, sy1], [ty0, ty1]], i) => {
					const x0 = nodeX(from) + PATH_NODE_W
					const x1 = nodeX(from + 1)
					const cx = (x0 + x1) / 2
					return (
						<path
							key={i}
							d={`M${x0},${sy0} C${cx},${sy0} ${cx},${ty0} ${x1},${ty0} L${x1},${ty1} C${cx},${ty1} ${cx},${sy1} ${x0},${sy1} Z`}
							fill={STROKE}
							fillOpacity={0.08}
							className="animate-pulse"
							style={{ animationDelay: `${-from * 0.2}s` }}
						/>
					)
				})}
				{PATH_COLUMNS.map((column, i) => {
					const last = i === columns - 1
					const x = nodeX(i)
					return column.map(([y0, y1], j) => (
						<g
							key={`${i}-${j}`}
							className="animate-pulse"
							style={{ animationDelay: `${-(i + j) * 0.13}s` }}
						>
							<rect
								x={x}
								y={y0}
								width={PATH_NODE_W}
								height={y1 - y0}
								fill={STROKE}
								fillOpacity={0.3}
							/>
							<rect
								x={last ? x - 1.2 - PATH_LABEL_W : x + PATH_NODE_W + 1.2}
								y={y0 + 0.6}
								width={PATH_LABEL_W}
								height={PATH_LABEL_H}
								fill={STROKE}
								fillOpacity={0.18}
							/>
						</g>
					))
				})}
			</svg>
		</div>
	)
}

const HISTOGRAM_HEIGHTS = [14, 28, 46, 68, 86, 96, 84, 64, 42, 26, 13]
const HEATMAP_COLS = 8
const HEATMAP_ROWS = 5

export function ChartSkeleton({ variant, className }: ChartSkeletonProps) {
	return (
		<div
			className={cn(
				"relative flex h-full w-full items-center justify-center overflow-hidden",
				className,
			)}
			data-slot="chart-skeleton"
			aria-hidden
		>
			{renderVariant(variant)}
		</div>
	)
}

function renderVariant(variant: ChartSkeletonVariant) {
	switch (variant) {
		case "line":
			return (
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full p-1">
					<GridLines />
					<TrendLine />
				</svg>
			)

		case "area":
			return (
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full p-1">
					<GridLines />
					<path d={`${TREND} L 98 100 L 2 100 Z`} fill={STROKE} fillOpacity={0.1} />
					<TrendLine />
				</svg>
			)

		case "bar":
			return (
				<div className="flex h-full w-full items-end gap-1.5 p-3">
					<Bars heights={BAR_HEIGHTS} delay={(i) => -i * 0.13} />
				</div>
			)

		case "histogram":
			return (
				<div className="flex h-full w-full items-end gap-[3px] p-3">
					<Bars
						heights={HISTOGRAM_HEIGHTS}
						delay={(i) => -Math.abs(i - (HISTOGRAM_HEIGHTS.length - 1) / 2) * 0.11}
					/>
				</div>
			)

		case "heatmap":
			return (
				<div
					className="grid h-full w-full gap-1 p-3"
					style={{
						gridTemplateColumns: `repeat(${HEATMAP_COLS},1fr)`,
						gridTemplateRows: `repeat(${HEATMAP_ROWS},1fr)`,
					}}
				>
					{Array.from({ length: HEATMAP_COLS * HEATMAP_ROWS }, (_, i) => {
						const row = Math.floor(i / HEATMAP_COLS)
						const col = i % HEATMAP_COLS
						return (
							<div
								key={i}
								className="rounded-sm bg-foreground/10 animate-pulse"
								style={{ animationDelay: `${-(row + col) * 0.13}s` }}
							/>
						)
					})}
				</div>
			)

		// Ranked rows: a label stub, a bar, and a value stub — the shape the real
		// panel draws, so the swap-in doesn't jump.
		case "hbar":
			return (
				<div className="flex h-full w-full flex-col justify-start gap-1.5 px-1">
					{[92, 78, 55, 34, 16].map((w, i) => (
						<div
							key={i}
							className="grid max-h-14 min-h-[18px] flex-1 items-center gap-2"
							style={{ gridTemplateColumns: "minmax(0, 38%) 1fr 44px" }}
						>
							<div
								className="h-2.5 rounded-[2px] bg-foreground/10"
								style={{ width: `${[72, 88, 60, 48, 66][i]}%` }}
							/>
							<div className="h-3 overflow-hidden rounded-[3px] bg-foreground/5">
								<div
									className="h-full rounded-[3px] bg-foreground/10 animate-pulse"
									style={{ width: `${w}%`, animationDelay: `${-i * 0.13}s` }}
								/>
							</div>
							<div className="h-2.5 w-full rounded-[2px] bg-foreground/10" />
						</div>
					))}
				</div>
			)

		case "funnel":
			return (
				<div className="flex h-full w-full flex-col justify-center gap-2 px-1">
					{[100, 64, 38, 18].map((w, i) => (
						<div key={i} className="flex flex-col gap-1">
							<div className="flex items-center justify-between">
								<div
									className="h-2.5 rounded-[2px] bg-foreground/10"
									style={{ width: `${[26, 34, 22, 30][i]}%` }}
								/>
								<div className="h-2.5 w-12 rounded-[2px] bg-foreground/10" />
							</div>
							<div className="h-2.5 overflow-hidden rounded-[3px] bg-foreground/5">
								<div
									className="h-full rounded-[3px] bg-foreground/10 animate-pulse"
									style={{ width: `${w}%`, animationDelay: `${-i * 0.13}s` }}
								/>
							</div>
						</div>
					))}
				</div>
			)

		// The drop-off view: a header stack per step, then a bar under a ghost of
		// the previous step's level.
		case "funnel-dropoff":
			return (
				<div className="flex h-full w-full flex-col px-1">
					<div className="flex justify-end pb-2">
						<div className="h-2.5 w-24 rounded-[2px] bg-foreground/10" />
					</div>
					<div className="grid min-h-0 flex-1 grid-cols-4 gap-3">
						{[100, 44, 20, 8].map((h, i) => {
							const prev = i === 0 ? h : [100, 44, 20, 8][i - 1]
							return (
								<div key={i} className="flex min-w-0 flex-col">
									<div className="flex flex-col gap-1.5">
										<div
											className="h-2.5 rounded-[2px] bg-foreground/10"
											style={{ width: `${[60, 72, 56, 64][i]}%` }}
										/>
										<div className="h-4 w-12 rounded-[3px] bg-foreground/15" />
										<div className="h-2.5 w-8 rounded-[2px] bg-foreground/10" />
									</div>
									<div className="relative mt-2.5 min-h-0 flex-1">
										{i > 0 && (
											<div
												className="absolute inset-x-0 rounded-[4px] bg-foreground/[0.04]"
												style={{ bottom: `${h}%`, height: `${prev - h}%` }}
											/>
										)}
										<div
											className="absolute inset-x-0 bottom-0 rounded-[4px] bg-foreground/10 animate-pulse"
											style={{ height: `${h}%`, animationDelay: `${-i * 0.13}s` }}
										/>
									</div>
								</div>
							)
						})}
					</div>
				</div>
			)

		case "paths":
			return <PathsGhost />

		case "pie":
			return (
				<svg
					viewBox="0 0 100 100"
					preserveAspectRatio="xMidYMid meet"
					className="h-full max-h-[88%] w-full"
				>
					<circle
						cx={50}
						cy={50}
						r={30}
						fill="none"
						stroke={STROKE}
						strokeOpacity={0.12}
						strokeWidth={16}
					/>
					<g className="skeleton-spin">
						<circle
							cx={50}
							cy={50}
							r={30}
							fill="none"
							stroke={STROKE}
							strokeOpacity={0.45}
							strokeWidth={16}
							strokeLinecap="round"
							pathLength={100}
							strokeDasharray="26 74"
						/>
					</g>
				</svg>
			)

		case "gauge":
			return (
				<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="h-full w-full">
					<path
						d="M 26 79 A 34 34 0 1 1 74 79"
						fill="none"
						stroke={STROKE}
						strokeOpacity={0.12}
						strokeWidth={9}
						strokeLinecap="round"
					/>
					<path
						d="M 26 79 A 34 34 0 1 1 74 79"
						fill="none"
						stroke={STROKE}
						strokeOpacity={0.55}
						strokeWidth={9}
						strokeLinecap="round"
						pathLength={100}
						className="skeleton-draw"
					/>
					<rect
						x={36}
						y={47}
						width={28}
						height={13}
						rx={3}
						fill={STROKE}
						fillOpacity={0.12}
						className="animate-pulse"
					/>
				</svg>
			)

		case "stat":
			return (
				<div className="flex h-full w-full flex-col items-center justify-center gap-2.5">
					<div className="h-8 w-24 rounded-md bg-foreground/10 animate-pulse" />
					<div
						className="h-3 w-14 rounded bg-foreground/10 animate-pulse"
						style={{ animationDelay: "0.2s" }}
					/>
				</div>
			)
	}
}
