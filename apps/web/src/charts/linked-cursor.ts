import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

// The linked cursor: hovering one
// chart paints a cursor at the same x ratio on every sibling, through CSS variables written
// imperatively, never through state.

/** The container's resting cursor variables. */
export const LINKED_CURSOR_STYLE = { "--linked-cursor-ratio": "0", "--linked-cursor-visible": "0" }

const CHART_SELECTOR = "[data-linked-cursor-chart]"
const OVERLAY_SELECTOR = "[data-linked-cursor-overlay]"
const PLOT_SELECTOR = "[data-chart-plot], .recharts-cartesian-grid"
const TOOLTIP_UPDATE_INTERVAL_MS = 1000 / 30

export const LinkedCursorMessage = defineMessageUnion({ CompletedMountLinkedCursor: {} })
export type LinkedCursorMessage = typeof LinkedCursorMessage.Type

/** The hovered chart, the last tooltip-forwarding move, and whether overlays sit on their plots. */
interface CursorState {
	active: HTMLElement | null
	lastTooltip: number
	aligned: boolean
}

const alignOverlays = (container: HTMLElement) => {
	const placements = [...container.querySelectorAll<HTMLElement>(CHART_SELECTOR)].flatMap((chart) => {
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
	})
	placements.forEach(({ overlay, left, top, width, height }) => {
		overlay.style.left = `${left}px`
		overlay.style.top = `${top}px`
		overlay.style.width = `${width}px`
		overlay.style.height = `${height}px`
	})
}

/** Pointer tracking on the container; emits `attached` once listening. A page with its own Message wraps this in its Mount. */
export const linkedCursorStream = <A>(element: Element, attached: A): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				if (!(element instanceof HTMLElement)) return () => undefined
				const container = element
				// Mutable listener state lives only as long as this Mount.
				const state: CursorState = { active: null, lastTooltip: 0, aligned: false }
				const setSource = (next: HTMLElement | null) => {
					if (state.active === next) return
					state.active?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.removeAttribute("hidden")
					state.active?.removeAttribute("data-linked-cursor-source")
					state.active = next
					next?.setAttribute("data-linked-cursor-source", "")
					next?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.setAttribute("hidden", "")
				}
				const hide = () => {
					container.style.setProperty("--linked-cursor-visible", "0")
					setSource(null)
				}
				const onMouseMove = (event: MouseEvent) => {
					const elapsed = event.timeStamp - state.lastTooltip
					if (state.lastTooltip === 0 || elapsed >= TOOLTIP_UPDATE_INTERVAL_MS) {
						state.lastTooltip = event.timeStamp
						return
					}
					event.stopPropagation()
				}
				const onPointerMove = (event: PointerEvent) => {
					const target = event.target
					const chart =
						target instanceof Element ? target.closest<HTMLElement>(CHART_SELECTOR) : null
					const plot = chart?.querySelector<Element>(PLOT_SELECTOR)
					const bounds = plot?.getBoundingClientRect()
					const isInside =
						chart !== null &&
						bounds !== undefined &&
						container.contains(chart) &&
						bounds.width !== 0 &&
						event.clientX >= bounds.left &&
						event.clientX <= bounds.right &&
						event.clientY >= bounds.top &&
						event.clientY <= bounds.bottom
					if (!isInside || chart === null || bounds === undefined) {
						state.aligned = false
						hide()
						return
					}
					if (!state.aligned) {
						state.aligned = true
						alignOverlays(container)
					}
					const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
					setSource(chart)
					container.style.setProperty("--linked-cursor-ratio", String(ratio))
					container.style.setProperty("--linked-cursor-visible", "1")
				}
				const onPointerLeave = () => {
					state.lastTooltip = 0
					state.aligned = false
					hide()
				}
				container.addEventListener("mousemove", onMouseMove, true)
				container.addEventListener("pointermove", onPointerMove)
				container.addEventListener("pointerleave", onPointerLeave)
				Queue.offerUnsafe(queue, attached)
				return () => {
					container.removeEventListener("mousemove", onMouseMove, true)
					container.removeEventListener("pointermove", onPointerMove)
					container.removeEventListener("pointerleave", onPointerLeave)
				}
			}),
			(release) => Effect.sync(release),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

/** `linkedCursorStream` as a Mount resolving `CompletedMountLinkedCursor`. */
export const MountLinkedCursor = Mount.defineStream("MountLinkedCursor", {
	messages: [LinkedCursorMessage.CompletedMountLinkedCursor],
	execute: ({ element }) => linkedCursorStream(element, LinkedCursorMessage.CompletedMountLinkedCursor()),
})

/** `LinkedCursorOverlay`: positioned and shown by `MountLinkedCursor`. */
export const linkedCursorOverlay = <M>(h: HtmlBuilder<M>, chartId: string): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class("pointer-events-none absolute"),
			h.DataAttribute("linked-cursor-overlay", chartId),
			h.Style({ "container-type": "inline-size", opacity: "var(--linked-cursor-visible)" }),
		],
		[
			h.div([
				h.Class("absolute inset-y-0 left-0 w-px bg-muted-foreground/45 will-change-transform"),
				h.Style({ transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))" }),
			]),
		],
	)
