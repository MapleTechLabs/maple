import type { MouseEvent, PointerEvent } from "react"
import { useRef } from "react"

/**
 * Linked cursor for every plot on screen, under either renderer.
 *
 * Recharts' own `syncId` synchronizes charts through its event bus: every
 * pointer move re-renders every synced chart's tooltip store (a render storm on
 * grids of 4+ charts). This hook keeps each chart fully independent and instead
 * paints a lightweight CSS-variable-driven cursor line across the sibling
 * plots — pointer moves only touch DOM style properties, never React state.
 *
 * The cursor position is GLOBAL: the ratio and visibility live in CSS variables
 * on the document element, so charts in separate containers — a metrics grid and
 * a correlation strip on the same page — track one pointer together. Each
 * container still opts in by spreading `containerProps`; that is what makes its
 * charts a pointer SOURCE, and what an unlinked chart omits.
 *
 * Usage:
 * - Spread `containerProps` on the element that wraps all linked charts.
 * - Mark each chart's positioned wrapper (the element containing the plot) with
 *   {@link linkedCursorChartProps} and render a {@link LinkedCursorOverlay}
 *   inside it, absolutely positioned against it.
 *
 * The overlay is aligned to each chart's own plot rect when the pointer enters
 * the container, so charts with different y-axis widths and margins all show
 * the cursor at the same time-bucket ratio — no chart has to be told what width
 * its neighbours resolved to. The hovered chart keeps its own native
 * cursor+tooltip (its overlay is hidden via the `data-linked-cursor-source`
 * marker); siblings show the CSS line.
 */

export const LINKED_CURSOR_CHART_ATTR = "data-linked-cursor-chart"
const CHART_SELECTOR = `[${LINKED_CURSOR_CHART_ATTR}]`
const OVERLAY_SELECTOR = "[data-linked-cursor-overlay]"
/**
 * The plot rect — the region inside the axes — under either renderer. Recharts
 * paints `.recharts-cartesian-grid`; `PlotFrame` positions an aria-hidden
 * `[data-chart-plot]` over the same box from its render callback.
 *
 * Mirrors `apps/web/perf/plot-locator.ts`, which the Playwright specs import.
 * Deliberately duplicated rather than shared: `perf/` is a separate Playwright
 * project outside the app's `src` graph, and reaching across that boundary to
 * save one string would put test-harness code in the production bundle's import
 * graph.
 */
const PLOT_SELECTOR = "[data-chart-plot], .recharts-cartesian-grid"
const TOOLTIP_UPDATE_INTERVAL_MS = 1000 / 30

/**
 * The chart currently under the pointer, shared across every hook instance:
 * moving from a chart in one linked container to a chart in another has to
 * un-hide the first one's overlay, and the two containers are different hooks.
 */
const activeChartRef = { current: null as HTMLElement | null }

function cursorRoot(): HTMLElement {
	return document.documentElement
}

export interface LinkedCursorContainerProps {
	onPointerEnter: () => void
	onMouseMoveCapture: (event: MouseEvent<HTMLElement>) => void
	onPointerMove: (event: PointerEvent<HTMLElement>) => void
	onPointerLeave: () => void
}

/** Marks a chart wrapper as a linked-cursor participant. Pass `undefined` to opt out. */
export function linkedCursorChartProps(chartId: string | undefined): Record<string, string> {
	return chartId == null ? {} : { [LINKED_CURSOR_CHART_ATTR]: chartId }
}

function setCursorSource(nextChart: HTMLElement | null) {
	if (activeChartRef.current === nextChart) return

	activeChartRef.current?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.removeAttribute("hidden")
	activeChartRef.current?.removeAttribute("data-linked-cursor-source")

	activeChartRef.current = nextChart
	nextChart?.setAttribute("data-linked-cursor-source", "")
	nextChart?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.setAttribute("hidden", "")
}

function hideLinkedCursor() {
	cursorRoot().style.setProperty("--linked-cursor-visible", "0")
	setCursorSource(null)
}

/**
 * Snap every overlay on the page onto its chart's plot rect. Runs on container
 * pointer enter — the cursor is only visible while hovering, so that is the only
 * moment alignment matters, and it keeps per-pointer-move work at zero reads.
 * It sweeps the whole document rather than the entered container because the
 * cursor is painted on every linked chart on screen, not just that container's.
 */
function alignOverlays() {
	const placements: Array<{
		overlay: HTMLElement
		left: number
		top: number
		width: number
		height: number
	}> = []
	for (const chart of document.querySelectorAll<HTMLElement>(CHART_SELECTOR)) {
		const overlay = chart.querySelector<HTMLElement>(OVERLAY_SELECTOR)
		const plot = chart.querySelector<Element>(PLOT_SELECTOR)
		const host = overlay?.offsetParent
		if (!overlay || !plot || !(host instanceof HTMLElement)) continue
		const plotBounds = plot.getBoundingClientRect()
		if (plotBounds.width === 0) continue
		const hostBounds = host.getBoundingClientRect()
		placements.push({
			overlay,
			left: plotBounds.left - hostBounds.left - host.clientLeft,
			top: plotBounds.top - hostBounds.top - host.clientTop,
			width: plotBounds.width,
			height: plotBounds.height,
		})
	}
	for (const { overlay, left, top, width, height } of placements) {
		overlay.style.left = `${left}px`
		overlay.style.top = `${top}px`
		overlay.style.width = `${width}px`
		overlay.style.height = `${height}px`
	}
}

export function useLinkedCursor(enabled: boolean): { containerProps: LinkedCursorContainerProps } {
	const lastTooltipUpdateRef = useRef(0)

	const handlePointerEnter = () => {
		if (!enabled) return
		alignOverlays()
	}

	const handleMouseMoveCapture = (event: MouseEvent<HTMLElement>) => {
		if (!enabled) return

		const elapsed = event.timeStamp - lastTooltipUpdateRef.current
		if (lastTooltipUpdateRef.current === 0 || elapsed >= TOOLTIP_UPDATE_INTERVAL_MS) {
			lastTooltipUpdateRef.current = event.timeStamp
			return
		}

		// Recharts handles mouse movement through React's BUBBLE phase, on an
		// ancestor of the plot, so stopping the synthetic event here keeps the
		// hovered Recharts chart's tooltip store at 30 updates/sec while the CSS
		// cursor stays at pointer-event speed.
		//
		// This does nothing for a TanStack chart, and does not need to: its renderer
		// binds NATIVE `pointermove` listeners to its own container
		// (`dist/renderer.js`, `dist/interaction-cursor.js`), a sibling of this React
		// tree — a synthetic `mousemove` stopped in React's capture phase never
		// reaches a native listener on a descendant element, and TanStack's tooltip
		// is imperative rather than React state, so there is no store to throttle.
		// The throttle survives because the infra grids (host metrics, k8s workloads,
		// the correlation panel) are still Recharts and still linked.
		event.stopPropagation()
	}

	const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
		if (!enabled) return

		const target = event.target
		const chart = target instanceof Element ? target.closest<HTMLElement>(CHART_SELECTOR) : null
		const plot = chart?.querySelector<Element>(PLOT_SELECTOR)
		if (!chart || !plot || !event.currentTarget.contains(chart)) {
			hideLinkedCursor()
			return
		}

		const bounds = plot.getBoundingClientRect()
		const insidePlot =
			event.clientX >= bounds.left &&
			event.clientX <= bounds.right &&
			event.clientY >= bounds.top &&
			event.clientY <= bounds.bottom
		if (!insidePlot || bounds.width === 0) {
			hideLinkedCursor()
			return
		}

		const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
		setCursorSource(chart)
		const root = cursorRoot().style
		root.setProperty("--linked-cursor-ratio", String(ratio))
		root.setProperty("--linked-cursor-visible", "1")
	}

	const handlePointerLeave = () => {
		if (!enabled) return
		lastTooltipUpdateRef.current = 0
		hideLinkedCursor()
	}

	return {
		containerProps: {
			onPointerEnter: handlePointerEnter,
			onMouseMoveCapture: handleMouseMoveCapture,
			onPointerMove: handlePointerMove,
			onPointerLeave: handlePointerLeave,
		},
	}
}

/**
 * The cursor line painted over sibling charts. Render inside a positioned
 * chart wrapper carrying {@link linkedCursorChartProps}; `alignOverlays`
 * positions it over the plot area on hover.
 */
export function LinkedCursorOverlay({ chartId }: { chartId: string }) {
	return (
		<div
			aria-hidden="true"
			data-linked-cursor-overlay={chartId}
			className="pointer-events-none absolute"
			style={{
				containerType: "inline-size",
				opacity: "var(--linked-cursor-visible, 0)",
			}}
		>
			<div
				className="absolute inset-y-0 left-0 w-px bg-muted-foreground/45 will-change-transform"
				style={{
					transform: "translateX(calc(var(--linked-cursor-ratio, 0) * (100cqw - 1px)))",
				}}
			/>
		</div>
	)
}
