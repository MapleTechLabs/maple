import { memo, Profiler, useCallback, useMemo, useRef, useState } from "react"

import {
	DashboardGrid,
	type CanvasWidget,
	type LayoutCommit,
} from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { tierForWidth } from "@/components/dashboard-builder/canvas/grid-breakpoints"
import { useContainerWidth } from "@/components/dashboard-builder/canvas/use-container-width"
import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	createReactRecorder,
	startInteractionBench,
	type InteractionBenchHarness,
} from "@/lab/bench/interaction-bench"

/**
 * The dashboard grid under load, for `perf/dashboard-grid.perf.spec.ts`: the
 * production `DashboardGrid` in edit mode over a `?n=`-widget board (default
 * 50). The react-grid-layout baseline it was measured against is recorded in
 * docs/benchmarks/dashboard-grid-2026-10-08.json.
 *
 * Tiles are memoised and draw ~150 elements each, standing in for a chart: a
 * grid that re-renders tile content while dragging pays for it here the way
 * it would on a real board.
 */

interface MountMetrics {
	mountMs: number
	layoutShift: number
	commits: number
}

export interface DashboardGridBenchHarness extends InteractionBenchHarness {
	/** Unmount and remount the board, timing it to the second frame after. */
	measureMount: () => Promise<MountMetrics>
	/** Widget content renders since the last `beginInteraction`. */
	contentRenders: () => number
	layoutCommits: () => number
	/** Widgets the last commit moved or resized. */
	lastCommitSize: () => number
}

declare global {
	interface Window {
		__dashboardGridBench?: DashboardGridBenchHarness
	}
}

interface BenchWidget extends CanvasWidget {
	title: string
}

/** A board shaped like real ones: rows of stats, pairs of charts, a wide table. */
function buildBoard(count: number): BenchWidget[] {
	const widgets: BenchWidget[] = []
	let y = 0
	while (widgets.length < count) {
		const band = Math.floor(y / 15) % 3
		if (band === 0) {
			for (let x = 0; x < 12 && widgets.length < count; x += 3) {
				widgets.push({
					id: `stat-${widgets.length}`,
					title: `Stat ${widgets.length}`,
					layout: { x, y, w: 3, h: 2 },
				})
			}
			y += 2
		} else if (band === 1) {
			for (let x = 0; x < 12 && widgets.length < count; x += 6) {
				widgets.push({
					id: `chart-${widgets.length}`,
					title: `Chart ${widgets.length}`,
					layout: { x, y, w: 6, h: 6 },
				})
			}
			y += 6
		} else {
			widgets.push({
				id: `table-${widgets.length}`,
				title: `Table ${widgets.length}`,
				layout: { x: 0, y, w: 12, h: 5 },
			})
			y += 5
		}
	}
	return widgets
}

const contentRenderCount = { value: 0 }
const BARS = Array.from({ length: 140 }, (_, index) => index)

const BenchTile = memo(function BenchTile({ widget }: { widget: BenchWidget }) {
	contentRenderCount.value += 1
	return (
		<div
			data-bench-tile={widget.id}
			className="flex h-full flex-col overflow-hidden rounded-lg border bg-card"
		>
			<div className="flex items-center gap-2 px-3 py-2 text-xs">
				<button
					type="button"
					className="widget-drag-handle cursor-grab touch-none text-muted-foreground"
					data-grid-label={widget.title}
					aria-label={`Move ${widget.title}`}
				>
					::
				</button>
				<span className="truncate">{widget.title}</span>
			</div>
			<div className="flex min-h-0 flex-1 items-end gap-px px-3 pb-2">
				{BARS.map((bar) => (
					<span
						key={bar}
						className="flex-1 bg-primary/40"
						style={{ height: `${20 + ((bar * 37 + widget.id.length * 11) % 80)}%` }}
					/>
				))}
			</div>
		</div>
	)
})

const nextPaint = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

export function DashboardGridBench({ count }: { count: number }) {
	const [widgets, setWidgets] = useState(() => buildBoard(count))
	const [mountKey, setMountKey] = useState(0)
	const containerRef = useRef<HTMLDivElement>(null)
	const width = useContainerWidth(containerRef)
	const tier = tierForWidth(width)
	const recorder = useMemo(() => createReactRecorder(), [])
	const commits = useRef(0)
	const lastCommitSize = useRef(0)

	// What `updateWidgetLayouts` in the dashboard store does: a widget whose box
	// did not change keeps its object, so its memoised renderer skips.
	const onLayoutCommit = useCallback((layouts: LayoutCommit) => {
		commits.current += 1
		const byId = new Map(layouts.map((layout) => [layout.i, layout]))
		setWidgets((current) => {
			let changed = 0
			const next = current.map((widget) => {
				const box = byId.get(widget.id)
				const { x, y, w, h } = widget.layout
				if (!box || (box.x === x && box.y === y && box.w === w && box.h === h)) return widget
				changed += 1
				return { ...widget, layout: { ...widget.layout, x: box.x, y: box.y, w: box.w, h: box.h } }
			})
			lastCommitSize.current = changed
			return next
		})
	}, [])

	useMountEffect(() => {
		const bench = startInteractionBench({
			recorder,
			isReady: () =>
				document.querySelectorAll("[data-bench-board] .widget-drag-handle").length >= count,
		})
		const harness: DashboardGridBenchHarness = Object.assign(bench.harness, {
			contentRenders: () => contentRenderCount.value,
			layoutCommits: () => commits.current,
			lastCommitSize: () => lastCommitSize.current,
			measureMount: async () => {
				let layoutShift = 0
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if ("value" in entry && typeof entry.value === "number") layoutShift += entry.value
					}
				})
				observer.observe({ type: "layout-shift", buffered: false })
				recorder.reset()
				const startedAt = performance.now()
				setMountKey((key) => key + 1)
				await nextPaint()
				const mountMs = performance.now() - startedAt
				// Let a library that settles after mount (transitions, a second
				// measure) finish shifting before reading the total.
				await new Promise((resolve) => setTimeout(resolve, 400))
				observer.disconnect()
				return { mountMs, layoutShift, commits: recorder.snapshot().commits }
			},
		})
		const begin = harness.beginInteraction
		harness.beginInteraction = () => {
			contentRenderCount.value = 0
			begin()
		}
		window.__dashboardGridBench = harness
		return () => {
			bench.dispose()
			if (window.__dashboardGridBench === harness) delete window.__dashboardGridBench
		}
	})

	return (
		<div className="p-6">
			<p className="mb-3 text-xs text-muted-foreground">
				{widgets.length} widgets · {tier.cols} columns
			</p>
			<div ref={containerRef} data-bench-board="">
				{width > 0 && (
					<Profiler id="dashboard-grid" onRender={recorder.onRender}>
						<DashboardGrid
							key={mountKey}
							widgets={widgets}
							width={width}
							tier={tier}
							editable={tier.canonical}
							renderWidget={BenchTile}
							onLayoutCommit={onLayoutCommit}
						/>
					</Profiler>
				)}
			</div>
		</div>
	)
}
