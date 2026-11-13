import { formatDuration } from "@maple/ui/lib/format"
import { getBrowserTimeZone, isValidIanaTimeZone } from "@maple/ui/lib/timezone"
import { Effect, Option, Queue, Schema, Stream, Array as Arr } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { badge } from "../ui/display"
import {
	decodePlotTimeAxis,
	PLOT_TIME_AXIS_ATTRIBUTE,
	type PlotTimeAxis,
	timeAtPlotX,
} from "./plot-time-axis"

// The linked cursor: hovering one chart paints a cursor at the same x ratio on every sibling,
// through CSS variables written imperatively on the overlays. Never on the container: the canvas
// renderer rebuilds its whole scene when any ancestor's `style` or `class` changes.
// The linked zoom rides on the same listeners: a drag across a time chart paints a band on every
// sibling and, on release, reports the span it covered.

/** The container's resting cursor variables. */
export const LINKED_CURSOR_STYLE = { "--linked-cursor-ratio": "0", "--linked-cursor-visible": "0" }

/** On a zooming group's container: the crosshair that says its charts can be dragged. */
export const LINKED_ZOOM_CLASS = "[&_.ts-chart-surface]:cursor-crosshair"

const CHART_SELECTOR = "[data-linked-cursor-chart]"
const OVERLAY_SELECTOR = "[data-linked-cursor-overlay]"
const LINE_SELECTOR = "[data-linked-cursor-line]"
const LABEL_SELECTOR = "[data-linked-zoom-label]"
const PLOT_SELECTOR = "[data-chart-plot], .recharts-cartesian-grid"
const SURFACE_SELECTOR = ".ts-chart-surface"
/** A press on a control, or on what a page lays over the plot (deploy markers), is not a drag. */
const PRESSABLE_SELECTOR = "a, button, [role='button'], input, select, textarea, [data-chart-overlay]"
const TOOLTIP_UPDATE_INTERVAL_MS = 1000 / 30
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 5
const DAY_MS = 86_400_000
/** A click this soon after a drag's release is the drag's own. */
const CLICK_AFTER_DRAG_MS = 50

export const LinkedCursorMessage = defineMessageUnion({
	CompletedMountLinkedCursor: {},
	/** A drag across a time chart ended on this span, in epoch ms. */
	SelectedChartRange: { startMs: Schema.Number, endMs: Schema.Number },
})
export type LinkedCursorMessage = typeof LinkedCursorMessage.Type

export interface ChartRange {
	readonly startMs: number
	readonly endMs: number
}

/** What makes a cursor group zoom: the clock its drag label reads in, and the Message a finished drag becomes. */
export interface LinkedZoom<A> {
	readonly timeZone: string
	readonly selected: (range: ChartRange) => A
}

/** One drag: the chart it started on, that plot's left edge and width (client px), and its time axis. */
interface Drag {
	readonly chart: HTMLElement
	readonly left: number
	readonly width: number
	readonly axis: PlotTimeAxis
	readonly fromX: number
	moved: boolean
}

/** The hovered chart, the last tooltip-forwarding move, the overlays placed on their plots (null until aligned), whether they show, and the drag in flight. */
interface CursorState {
	active: HTMLElement | null
	lastTooltip: number
	overlays: ReadonlyArray<HTMLElement> | null
	visible: boolean
	drag: Drag | null
	/** When the last drag was released (an event timestamp), to tell its trailing click from a real one. */
	dragEndedAt: number
}

/** The span between two client x positions on a plot whose left edge is `plotLeft`, in order. */
export const draggedRange = (
	axis: PlotTimeAxis,
	plotLeft: number,
	fromX: number,
	toX: number,
): ChartRange => {
	const from = timeAtPlotX(axis, fromX - plotLeft)
	const to = timeAtPlotX(axis, toX - plotLeft)
	return { startMs: Math.min(from, to), endMs: Math.max(from, to) }
}

/** The drag's label: both ends on the clock, then how long the span is. */
export const zoomLabel = (range: ChartRange, clock: (ms: number, withDay: boolean) => string): string => {
	const span = range.endMs - range.startMs
	const withDay = span >= DAY_MS / 2
	return `${clock(range.startMs, withDay)} to ${clock(range.endMs, withDay)} · ${formatDuration(span)}`
}

const clockOf = (timeZone: string) => {
	const zone = isValidIanaTimeZone(timeZone) ? timeZone : getBrowserTimeZone()
	const time = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" })
	const dayTime = new Intl.DateTimeFormat(undefined, {
		timeZone: zone,
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	})
	return (ms: number, withDay: boolean) => (withDay ? dayTime : time).format(ms)
}

const alignOverlays = (container: HTMLElement) => {
	const placements = Arr.flatMap([...container.querySelectorAll<HTMLElement>(CHART_SELECTOR)], (chart) => {
		const overlay = chart.querySelector<HTMLElement>(OVERLAY_SELECTOR)
		const plot = chart.querySelector(PLOT_SELECTOR)
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
	Arr.forEach(placements, ({ overlay, left, top, width, height }) => {
		overlay.style.left = `${left}px`
		overlay.style.top = `${top}px`
		overlay.style.width = `${width}px`
		overlay.style.height = `${height}px`
	})
	return Arr.map(placements, ({ overlay }) => overlay)
}

const ratioOf = (x: number, left: number, width: number) => Math.min(1, Math.max(0, (x - left) / width))

/**
 * Pointer tracking on the container; emits `attached` once listening. A page with its own Message
 * wraps this in its Mount. With `zoom`, a drag across a time chart also emits `zoom.selected`.
 */
export const linkedCursorStream = <A>(
	element: Element,
	attached: A,
	zoom?: LinkedZoom<A>,
): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				if (!(element instanceof HTMLElement)) return () => undefined
				const container = element
				// Mutable listener state lives only as long as this Mount.
				const state: CursorState = {
					active: null,
					lastTooltip: 0,
					overlays: null,
					visible: false,
					drag: null,
					dragEndedAt: Number.NEGATIVE_INFINITY,
				}
				const setVisible = (visible: boolean) => {
					if (state.visible === visible) return
					state.visible = visible
					Arr.forEach(state.overlays ?? [], (overlay) =>
						overlay.style.setProperty("--linked-cursor-visible", visible ? "1" : "0"),
					)
				}
				// The hovered chart draws its own cursor, so its overlay line is hidden; its band still shows.
				const setSource = (next: HTMLElement | null) => {
					if (state.active === next) return
					state.active?.querySelector<HTMLElement>(LINE_SELECTOR)?.removeAttribute("hidden")
					state.active?.removeAttribute("data-linked-cursor-source")
					state.active = next
					next?.setAttribute("data-linked-cursor-source", "")
					next?.querySelector<HTMLElement>(LINE_SELECTOR)?.setAttribute("hidden", "")
				}
				const hide = () => {
					setVisible(false)
					setSource(null)
				}
				const hitOf = (event: PointerEvent) => {
					const target = event.target
					const chart =
						target instanceof Element ? target.closest<HTMLElement>(CHART_SELECTOR) : null
					const plot = chart?.querySelector(PLOT_SELECTOR) ?? null
					const bounds = plot?.getBoundingClientRect()
					return chart !== null &&
						plot !== null &&
						bounds !== undefined &&
						container.contains(chart) &&
						bounds.width !== 0 &&
						event.clientX >= bounds.left &&
						event.clientX <= bounds.right &&
						event.clientY >= bounds.top &&
						event.clientY <= bounds.bottom
						? { chart, plot, bounds }
						: null
				}
				const onMouseMove = (event: MouseEvent) => {
					// A drag in flight holds the chart's own tooltip where it was.
					if (state.drag?.moved === true) {
						event.stopPropagation()
						return
					}
					const elapsed = event.timeStamp - state.lastTooltip
					if (state.lastTooltip === 0 || elapsed >= TOOLTIP_UPDATE_INTERVAL_MS) {
						state.lastTooltip = event.timeStamp
						return
					}
					event.stopPropagation()
				}
				const onPointerMove = (event: PointerEvent) => {
					if (state.drag?.moved === true) return
					const hit = hitOf(event)
					if (hit === null) {
						hide()
						state.overlays = null
						return
					}
					const overlays = state.overlays ?? alignOverlays(container)
					state.overlays = overlays
					const ratio = String(ratioOf(event.clientX, hit.bounds.left, hit.bounds.width))
					setSource(hit.chart)
					Arr.forEach(overlays, (overlay) =>
						overlay.style.setProperty("--linked-cursor-ratio", ratio),
					)
					setVisible(true)
				}
				const onPointerLeave = () => {
					state.lastTooltip = 0
					hide()
					if (state.drag === null) state.overlays = null
				}
				container.addEventListener("mousemove", onMouseMove, true)
				container.addEventListener("pointermove", onPointerMove)
				container.addEventListener("pointerleave", onPointerLeave)
				const stopZoom =
					zoom === undefined
						? () => undefined
						: listenForDrags(container, state, zoom, hitOf, setVisible, (range) =>
								Queue.offerUnsafe(queue, zoom.selected(range)),
							)
				Queue.offerUnsafe(queue, attached)
				return () => {
					stopZoom()
					container.removeEventListener("mousemove", onMouseMove, true)
					container.removeEventListener("pointermove", onPointerMove)
					container.removeEventListener("pointerleave", onPointerLeave)
				}
			}),
			(release) => Effect.sync(release),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

type Hit = { readonly chart: HTMLElement; readonly plot: Element; readonly bounds: DOMRect }

/** The drag half of the stream: press on a time plot, move past the threshold, release. Returns its teardown. */
const listenForDrags = <A>(
	container: HTMLElement,
	state: CursorState,
	zoom: LinkedZoom<A>,
	hitOf: (event: PointerEvent) => Hit | null,
	setCursorVisible: (visible: boolean) => void,
	selected: (range: ChartRange) => void,
): (() => void) => {
	const clock = clockOf(zoom.timeZone)
	const paintBand = (drag: Drag, toX: number) => {
		const overlays = state.overlays ?? alignOverlays(container)
		state.overlays = overlays
		const from = ratioOf(drag.fromX, drag.left, drag.width)
		const to = ratioOf(toX, drag.left, drag.width)
		Arr.forEach(overlays, (overlay) => {
			overlay.style.setProperty("--linked-zoom-start", String(Math.min(from, to)))
			overlay.style.setProperty("--linked-zoom-end", String(Math.max(from, to)))
			overlay.style.setProperty("--linked-zoom-visible", "1")
		})
		const label = drag.chart.querySelector<HTMLElement>(LABEL_SELECTOR)
		if (label !== null)
			label.textContent = zoomLabel(draggedRange(drag.axis, drag.left, drag.fromX, toX), clock)
	}
	const clearBand = (drag: Drag) => {
		Arr.forEach(state.overlays ?? [], (overlay) =>
			overlay.style.setProperty("--linked-zoom-visible", "0"),
		)
		const label = drag.chart.querySelector<HTMLElement>(LABEL_SELECTOR)
		if (label !== null) label.textContent = ""
	}
	const cancel = () => {
		const drag = state.drag
		state.drag = null
		if (drag?.moved === true) clearBand(drag)
	}
	// The click that follows a drag's release would land on whatever is under the pointer.
	const swallowClick = (event: MouseEvent) => {
		if (event.timeStamp - state.dragEndedAt > CLICK_AFTER_DRAG_MS) return
		event.stopPropagation()
		event.preventDefault()
	}
	const onPointerDown = (event: PointerEvent) => {
		const target = event.target
		if (event.button !== 0 || event.pointerType === "touch" || !(target instanceof Element)) return
		if (target.closest(PRESSABLE_SELECTOR) !== null) return
		const hit = hitOf(event)
		if (hit === null) return
		const axis = decodePlotTimeAxis(hit.plot.getAttribute(PLOT_TIME_AXIS_ATTRIBUTE))
		if (Option.isNone(axis)) return
		state.drag = {
			chart: hit.chart,
			left: hit.bounds.left,
			width: hit.bounds.width,
			axis: axis.value,
			fromX: event.clientX,
			moved: false,
		}
	}
	const onDragMove = (event: PointerEvent) => {
		const drag = state.drag
		if (drag === null) return
		// A release the page never saw (the window lost focus mid-drag): no button is down any more.
		if ((event.buttons & 1) === 0) {
			cancel()
			return
		}
		if (!drag.moved) {
			if (Math.abs(event.clientX - drag.fromX) < DRAG_THRESHOLD_PX) return
			drag.moved = true
			setCursorVisible(false)
			getSelection()?.removeAllRanges()
			// The chart clears its own cursor and tooltip on a leave; moves are held back until release.
			drag.chart.querySelector(SURFACE_SELECTOR)?.dispatchEvent(new MouseEvent("mouseleave"))
		}
		paintBand(drag, event.clientX)
	}
	const onDragEnd = (event: PointerEvent) => {
		const drag = state.drag
		state.drag = null
		if (drag === null || !drag.moved) return
		clearBand(drag)
		state.dragEndedAt = event.timeStamp
		if (Math.abs(event.clientX - drag.fromX) < DRAG_THRESHOLD_PX) return
		const range = draggedRange(drag.axis, drag.left, drag.fromX, event.clientX)
		if (range.endMs > range.startMs) selected(range)
	}
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") cancel()
	}
	const onSelectStart = (event: Event) => {
		if (state.drag !== null) event.preventDefault()
	}
	// The chart follows `pointermove` for its own cursor and tooltip: none reach it mid-drag.
	const holdChart = (event: PointerEvent) => {
		if (state.drag?.moved === true) event.stopPropagation()
	}
	container.addEventListener("pointerdown", onPointerDown)
	container.addEventListener("selectstart", onSelectStart)
	container.addEventListener("click", swallowClick, true)
	container.addEventListener("pointermove", holdChart, true)
	// Capture on the document: these run before `holdChart` stops the event.
	document.addEventListener("pointermove", onDragMove, true)
	document.addEventListener("pointerup", onDragEnd)
	document.addEventListener("pointercancel", cancel)
	document.addEventListener("keydown", onKeyDown)
	return () => {
		container.removeEventListener("pointerdown", onPointerDown)
		container.removeEventListener("selectstart", onSelectStart)
		container.removeEventListener("click", swallowClick, true)
		container.removeEventListener("pointermove", holdChart, true)
		document.removeEventListener("pointermove", onDragMove, true)
		document.removeEventListener("pointerup", onDragEnd)
		document.removeEventListener("pointercancel", cancel)
		document.removeEventListener("keydown", onKeyDown)
	}
}

/** `linkedCursorStream` as a Mount resolving `CompletedMountLinkedCursor`. */
export const MountLinkedCursor = Mount.defineStream("MountLinkedCursor", {
	messages: [LinkedCursorMessage.CompletedMountLinkedCursor],
	execute: ({ element }) => linkedCursorStream(element, LinkedCursorMessage.CompletedMountLinkedCursor()),
})

/** `MountLinkedCursor` for a group whose charts zoom: a drag across one resolves `SelectedChartRange`. */
export const MountLinkedZoom = Mount.defineStream("MountLinkedZoom", {
	args: { timeZone: Schema.String },
	messages: [LinkedCursorMessage.CompletedMountLinkedCursor, LinkedCursorMessage.SelectedChartRange],
	execute: ({ element, timeZone }) =>
		linkedCursorStream<LinkedCursorMessage>(element, LinkedCursorMessage.CompletedMountLinkedCursor(), {
			timeZone,
			selected: (range) => LinkedCursorMessage.SelectedChartRange(range),
		}),
})

/** The linked cursor overlay: the cursor line and the zoom band, positioned and shown by the Mount. */
export const linkedCursorOverlay = <M>(h: HtmlBuilder<M>, chartId: string): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class("pointer-events-none absolute"),
			h.DataAttribute("linked-cursor-overlay", chartId),
			h.Style({ "container-type": "inline-size" }),
		],
		[
			h.div([
				h.DataAttribute("linked-cursor-line", ""),
				h.Class("absolute inset-y-0 left-0 w-px bg-foreground-faint will-change-transform"),
				h.Style({
					opacity: "var(--linked-cursor-visible)",
					transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))",
				}),
			]),
			h.div(
				[
					h.DataAttribute("linked-zoom-band", ""),
					h.Class("absolute inset-y-0 border-x border-primary-a4 bg-primary-a2"),
					h.Style({
						left: "calc(var(--linked-zoom-start, 0) * 100cqw)",
						width: "calc((var(--linked-zoom-end, 0) - var(--linked-zoom-start, 0)) * 100cqw)",
						opacity: "var(--linked-zoom-visible, 0)",
					}),
				],
				[
					badge(
						h,
						{
							// `max-w-none`: the label may be wider than a narrow band.
							className: "absolute top-1 left-1/2 max-w-none -translate-x-1/2 empty:hidden",
							attributes: [h.DataAttribute("linked-zoom-label", "")],
						},
						[],
					),
				],
			),
		],
	)
