import { Effect, Schema } from "effect"
import { Mount } from "foldkit"
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
const MIN_ZOOM = 0.5
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

const wirePanZoom = (frame: HTMLElement): (() => void) => {
	const stage = frame.querySelector("[role=application]")
	if (!(stage instanceof HTMLElement)) return () => {}
	const view: PanZoomView = { zoom: 1, x: 0, y: 0, drag: null }
	const apply = () => {
		stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
		frame.querySelectorAll("[data-mermaid-control]").forEach((button) => {
			if (!(button instanceof HTMLButtonElement)) return
			const control = button.dataset.mermaidControl
			button.disabled = (control === "in" && view.zoom >= MAX_ZOOM) || (control === "out" && view.zoom <= MIN_ZOOM)
		})
	}
	const onClick = (event: Event) => {
		const control = event.target instanceof Element ? event.target.closest("[data-mermaid-control]") : null
		if (!(control instanceof HTMLElement)) return
		const kind = control.dataset.mermaidControl
		if (kind === "in") view.zoom = Math.min(MAX_ZOOM, view.zoom + ZOOM_STEP)
		if (kind === "out") view.zoom = Math.max(MIN_ZOOM, view.zoom - ZOOM_STEP)
		if (kind === "reset") Object.assign(view, { zoom: 1, x: 0, y: 0 })
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
	frame.addEventListener("click", onClick)
	frame.addEventListener("pointerdown", onDown)
	window.addEventListener("pointermove", onMove)
	window.addEventListener("pointerup", onUp)
	return () => {
		frame.removeEventListener("click", onClick)
		frame.removeEventListener("pointerdown", onDown)
		window.removeEventListener("pointermove", onMove)
		window.removeEventListener("pointerup", onUp)
	}
}

/** On the diagram frame: render once, then pan and zoom until the frame unmounts. */
export const MountMermaid = Mount.define("MountChatMermaid", {
	args: { code: Schema.String },
	messages: [MermaidMessage.CompletedMountMermaid, MermaidMessage.FailedMountMermaid],
	execute: ({ element, code }) =>
		Effect.gen(function* () {
			const { default: mermaid } = yield* Effect.promise(() => import("mermaid"))
			// Streamdown keeps mermaid's default theme in both app themes.
			mermaid.initialize({ ...CONFIG, theme: "default" })
			const id = `mermaid-${crypto.randomUUID().slice(0, 8)}`
			const { svg } = yield* Effect.tryPromise(() => mermaid.render(id, code))
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					const slot = element.querySelector("[role=img]")
					if (slot instanceof HTMLElement) slot.innerHTML = svg
					const drawn = slot?.querySelector("svg")
					if (drawn instanceof SVGSVGElement && element instanceof HTMLElement) element.style.height = `${pinSize(drawn)}px`
					return element instanceof HTMLElement ? wirePanZoom(element) : () => {}
				}),
				(release) => Effect.sync(release),
			)
			return MermaidMessage.CompletedMountMermaid()
		}).pipe(Effect.orElseSucceed(() => MermaidMessage.FailedMountMermaid())),
})
