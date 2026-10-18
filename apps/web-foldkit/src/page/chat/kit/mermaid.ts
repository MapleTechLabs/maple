import { Effect, Option, Schema, Stream } from "effect"
import { Dom, Mount } from "foldkit"
import { lockBodyScroll, portalToBody } from "../../../ui/overlay/portal"
import { defineMessageUnion } from "foldkit/message"

// `@streamdown/mermaid` + Streamdown's `Mermaid` (`PanZoom`): mermaid loads with the first diagram,
// renders it into the frame's `img` slot, sizes the frame to the SVG, and drives pan and zoom.
// The slot has no virtual children, so the view never touches what mermaid drew.

export const MermaidMessage = defineMessageUnion({ CompletedMountMermaid: {}, FailedMountMermaid: {} })

/** `defaultConfig` of `@streamdown/mermaid`. */
const CONFIG = {
	startOnLoad: false,
	securityLevel: "strict",
	fontFamily: "monospace",
	suppressErrorRendering: true,
} satisfies Parameters<(typeof import("mermaid"))["default"]["initialize"]>[0]

const ZOOM_STEP = 0.1
const MIN_ZOOM = 0.1
const MAX_ZOOM = 3

/** Streamdown pins the SVG to its own size so the frame, not the SVG, decides the layout. */
const pinSize = (svg: SVGSVGElement): number => {
	const box = svg.viewBox.baseVal
	svg.setAttribute("width", String(box.width))
	svg.setAttribute("height", String(box.height))
	svg.setAttribute("style", `width:${box.width}px;height:${box.height}px;max-width:none;`)
	return box.height
}

/** The frame's pan and zoom, the DOM glue's own bookkeeping (`PanZoom`'s state). */
interface PanZoomView {
	zoom: number
	x: number
	y: number
	drag: { readonly x: number; readonly y: number } | null
}

const wirePanZoom = (frame: HTMLElement, fit: number): (() => void) => {
	const stage = frame.querySelector("[role=application]")
	if (!(stage instanceof HTMLElement)) return () => {}
	const minZoom = Math.min(MIN_ZOOM, fit)
	const view: PanZoomView = { zoom: fit, x: 0, y: 0, drag: null }
	const apply = () => {
		stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
		frame.querySelectorAll("[data-mermaid-control]").forEach((button) => {
			if (!(button instanceof HTMLButtonElement)) return
			const control = button.dataset.mermaidControl
			button.disabled = (control === "in" && view.zoom >= MAX_ZOOM) || (control === "out" && view.zoom <= minZoom)
		})
	}
	const onClick = (event: Event) => {
		const control = event.target instanceof Element ? event.target.closest("[data-mermaid-control]") : null
		if (!(control instanceof HTMLElement)) return
		const kind = control.dataset.mermaidControl
		if (kind === "in") view.zoom = Math.min(MAX_ZOOM, view.zoom + ZOOM_STEP)
		if (kind === "out") view.zoom = Math.max(minZoom, view.zoom - ZOOM_STEP)
		if (kind === "reset") Object.assign(view, { zoom: fit, x: 0, y: 0 })
		apply()
	}
	const onDown = (event: PointerEvent) => {
		if (event.target instanceof Element && event.target.closest("button") !== null) return
		view.drag = { x: event.clientX - view.x, y: event.clientY - view.y }
		frame.style.cursor = "grabbing"
	}
	const onMove = (event: PointerEvent) => {
		if (view.drag === null) return
		view.x = event.clientX - view.drag.x
		view.y = event.clientY - view.drag.y
		apply()
	}
	const onUp = () => {
		view.drag = null
		frame.style.cursor = "grab"
	}
	const onWheel = (event: WheelEvent) => {
		event.preventDefault()
		view.zoom = Math.max(minZoom, Math.min(MAX_ZOOM, view.zoom + (event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)))
		apply()
	}
	apply()
	frame.addEventListener("click", onClick)
	frame.addEventListener("pointerdown", onDown)
	frame.addEventListener("wheel", onWheel, { passive: false })
	window.addEventListener("pointermove", onMove)
	window.addEventListener("pointerup", onUp)
	return () => {
		frame.removeEventListener("click", onClick)
		frame.removeEventListener("pointerdown", onDown)
		frame.removeEventListener("wheel", onWheel)
		window.removeEventListener("pointermove", onMove)
		window.removeEventListener("pointerup", onUp)
	}
}

/** `PanZoom`'s fullscreen fit: the whole diagram in the frame, never enlarged. */
const fullscreenFit = (frame: HTMLElement, svg: SVGSVGElement): number => {
	const box = svg.viewBox.baseVal
	const fit = Math.min(frame.clientWidth / box.width, frame.clientHeight / box.height, 1)
	return fit > 0 && Number.isFinite(fit) ? fit : 1
}

/** Renders `code` with mermaid as Streamdown configures it; the source's own SVG. */
export const renderMermaid = (code: string) =>
	Effect.gen(function* () {
		const { default: mermaid } = yield* Effect.promise(() => import("mermaid"))
		// Streamdown keeps mermaid's default theme in both app themes.
		mermaid.initialize({ ...CONFIG, theme: "default" })
		const id = `mermaid-${crypto.randomUUID().slice(0, 8)}`
		const { svg } = yield* Effect.tryPromise(() => mermaid.render(id, code))
		return svg
	})

/**
 * On the diagram frame: render once, then pan and zoom until the frame unmounts. Inline, the SVG
 * is pinned to its size and sizes the frame; fullscreen, it keeps mermaid's sizing and is fitted.
 */
export const MountMermaid = Mount.define("MountChatMermaid", {
	args: { code: Schema.String, isFullscreen: Schema.Boolean },
	messages: [MermaidMessage.CompletedMountMermaid, MermaidMessage.FailedMountMermaid],
	execute: ({ element, code, isFullscreen }) =>
		Effect.gen(function* () {
			const svg = yield* renderMermaid(code)
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					const slot = element.querySelector("[role=img]")
					if (slot instanceof HTMLElement) slot.innerHTML = svg
					const drawn = slot?.querySelector("svg")
					if (!(element instanceof HTMLElement) || !(drawn instanceof SVGSVGElement)) return () => {}
					if (isFullscreen) return wirePanZoom(element, fullscreenFit(element, drawn))
					element.style.height = `${pinSize(drawn)}px`
					return wirePanZoom(element, 1)
				}),
				(release) => Effect.sync(release),
			)
			return MermaidMessage.CompletedMountMermaid()
		}).pipe(Effect.orElseSucceed(() => MermaidMessage.FailedMountMermaid())),
})

export const DiagramMessage = defineMessageUnion({
	CompletedMountDiagramOverlay: {},
	PressedOutsideDiagramMenu: {},
	PressedEscapeDiagramFullscreen: {},
	PressedDiagramBackdrop: {},
})

/** On the open download menu (`ct`): a mousedown outside its wrapper (the toggle and the menu) closes it. */
export const MountDiagramMenu = Mount.defineStream("MountChatDiagramMenu", {
	messages: [DiagramMessage.CompletedMountDiagramOverlay, DiagramMessage.PressedOutsideDiagramMenu],
	execute: ({ element }) =>
		Stream.concat(
			Stream.make(DiagramMessage.CompletedMountDiagramOverlay()),
			Dom.streamFromEventFilterMap({
				target: () => document,
				type: "mousedown",
				filterMapEvent: (event) =>
					event.composedPath().includes(element.parentElement ?? element) ? Option.none() : Option.some(DiagramMessage.PressedOutsideDiagramMenu()),
			}),
		),
})

/** The fullscreen dialog: portaled to `<body>`, the page scroll locked; Escape or a click on the backdrop itself closes it. */
export const MountDiagramFullscreen = Mount.defineStream("MountChatDiagramFullscreen", {
	messages: [
		DiagramMessage.CompletedMountDiagramOverlay,
		DiagramMessage.PressedEscapeDiagramFullscreen,
		DiagramMessage.PressedDiagramBackdrop,
	],
	execute: ({ element }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				yield* portalToBody(element)
				yield* lockBodyScroll
				const escapes = Dom.streamFromEventFilterMap({
					target: () => document,
					type: "keydown",
					filterMapEvent: (event) =>
						event.key === "Escape" ? Option.some(DiagramMessage.PressedEscapeDiagramFullscreen()) : Option.none(),
				})
				// The dialog's children stop their clicks, so only one on the dialog itself closes it.
				const backdrop = Dom.streamFromEventFilterMap({
					target: () => element,
					type: "click",
					filterMapEvent: (event) =>
						event.target === element ? Option.some(DiagramMessage.PressedDiagramBackdrop()) : Option.none(),
				})
				return Stream.concat(Stream.make(DiagramMessage.CompletedMountDiagramOverlay()), Stream.merge(escapes, backdrop))
			}),
		),
})
