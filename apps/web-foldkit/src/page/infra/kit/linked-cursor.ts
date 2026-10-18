import { Effect } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

// `useLinkedCursor` / `LinkedCursorOverlay` (apps/web/src/hooks/use-linked-cursor.tsx): the CSS
// cursor line drawn over every sibling chart while one is hovered. Pure DOM work on the container,
// so it is a Mount; the view renders the overlays and the chart markers.

export const LINKED_CURSOR_STYLE = { "--linked-cursor-ratio": "0", "--linked-cursor-visible": "0" }

const CHART_SELECTOR = "[data-linked-cursor-chart]"
const OVERLAY_SELECTOR = "[data-linked-cursor-overlay]"
const PLOT_SELECTOR = "[data-chart-plot], .recharts-cartesian-grid"

export const LinkedCursorMessage = defineMessageUnion({ CompletedMountLinkedCursor: {} })
export type LinkedCursorMessage = typeof LinkedCursorMessage.Type

/** `alignOverlays`: snaps each overlay onto its chart's plot rect, once per hover session. */
const alignOverlays = (container: HTMLElement) => {
	const placements = Array.from(container.querySelectorAll<HTMLElement>(CHART_SELECTOR)).flatMap(
		(chart) => {
			const overlay = chart.querySelector<HTMLElement>(OVERLAY_SELECTOR)
			const plot = chart.querySelector<Element>(PLOT_SELECTOR)
			const host = overlay?.offsetParent
			if (!overlay || !plot || !(host instanceof HTMLElement)) return []
			const plotBounds = plot.getBoundingClientRect()
			if (plotBounds.width === 0) return []
			const hostBounds = host.getBoundingClientRect()
			return [
				{
					overlay,
					left: plotBounds.left - hostBounds.left - host.clientLeft,
					top: plotBounds.top - hostBounds.top - host.clientTop,
					width: plotBounds.width,
					height: plotBounds.height,
				},
			]
		},
	)
	placements.forEach(({ overlay, left, top, width, height }) => {
		overlay.style.left = `${left}px`
		overlay.style.top = `${top}px`
		overlay.style.width = `${width}px`
		overlay.style.height = `${height}px`
	})
}

/** The chart the pointer is over, and whether this hover session aligned the overlays yet. */
interface HoverSession {
	active: HTMLElement | null
	aligned: boolean
}

/** Wires the hover session on the container; returns the release. */
const attach = (element: HTMLElement) => {
	const session: HoverSession = { active: null, aligned: false }
	const setSource = (next: HTMLElement | null) => {
		if (session.active === next) return
		session.active?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.removeAttribute("hidden")
		session.active?.removeAttribute("data-linked-cursor-source")
		session.active = next
		next?.setAttribute("data-linked-cursor-source", "")
		next?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.setAttribute("hidden", "")
	}
	const hide = () => {
		session.aligned = false
		element.style.setProperty("--linked-cursor-visible", "0")
		setSource(null)
	}
	const onMove = (event: PointerEvent) => {
		const target = event.target
		const chart = target instanceof Element ? target.closest<HTMLElement>(CHART_SELECTOR) : null
		const plot = chart?.querySelector<Element>(PLOT_SELECTOR)
		if (!chart || !plot || !element.contains(chart)) return hide()
		const bounds = plot.getBoundingClientRect()
		const inside =
			event.clientX >= bounds.left &&
			event.clientX <= bounds.right &&
			event.clientY >= bounds.top &&
			event.clientY <= bounds.bottom
		if (!inside || bounds.width === 0) return hide()
		if (!session.aligned) {
			session.aligned = true
			alignOverlays(element)
		}
		const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
		setSource(chart)
		element.style.setProperty("--linked-cursor-ratio", String(ratio))
		element.style.setProperty("--linked-cursor-visible", "1")
	}
	element.addEventListener("pointermove", onMove)
	element.addEventListener("pointerleave", hide)
	return () => {
		element.removeEventListener("pointermove", onMove)
		element.removeEventListener("pointerleave", hide)
	}
}

export const MountLinkedCursor = Mount.define("MountLinkedCursor", {
	messages: [LinkedCursorMessage.CompletedMountLinkedCursor],
	execute: ({ element }) =>
		Effect.gen(function* () {
			yield* Effect.acquireRelease(
				Effect.sync(() => (element instanceof HTMLElement ? attach(element) : () => undefined)),
				(release) => Effect.sync(release),
			)
			return LinkedCursorMessage.CompletedMountLinkedCursor()
		}),
})

/** `LinkedCursorOverlay`. */
export const linkedCursorOverlay = <M>(h: HtmlBuilder<M>, chartId: string): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.DataAttribute("linked-cursor-overlay", chartId),
			h.Class("pointer-events-none absolute"),
			h.Style({ "container-type": "inline-size", opacity: "var(--linked-cursor-visible)" }),
		],
		[
			h.div([
				h.Class("absolute inset-y-0 left-0 w-px bg-muted-foreground/45 will-change-transform"),
				h.Style({ transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))" }),
			]),
		],
	)
