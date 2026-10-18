import { Effect, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import { Message } from "./canvas"
import type { HandleBounds, MeasuredNode, Viewport, XY } from "./geometry"

/** The renderer carries the Model's camera here so d3-zoom can be synced before a gesture. */
export const VIEWPORT_ATTRIBUTE = "data-viewport"

/** Bumped by the Model (`Canvas.remeasure`) to re-measure every node. */
export const MEASURE_EPOCH_ATTRIBUTE = "data-measure-epoch"

export const viewportAttribute = (viewport: Viewport): string =>
	`${viewport.x},${viewport.y},${viewport.zoom}`

/** An animated camera move the Model asks for (`fitView({ duration })`), run by d3 in the Mount. */
export const ANIMATION_ATTRIBUTE = "data-camera-animation"

export const animationAttribute = (animation: {
	readonly seq: number
	readonly target: Viewport
	readonly duration: number
}): string =>
	`${animation.seq},${animation.target.x},${animation.target.y},${animation.target.zoom},${animation.duration}`

/**
 * The Model's camera, written on the empty `.react-flow__viewport-portal` leaf: an attribute that
 * changes every pan frame on an ancestor of the nodes costs a ~30 ms style recalc per frame.
 */
export const readViewport = (renderer: Element): Viewport | undefined => {
	const leaf = renderer.querySelector(".react-flow__viewport-portal")
	const parts = (leaf?.getAttribute(VIEWPORT_ATTRIBUTE) ?? "").split(",").map(Number)
	return parts.length === 3 && parts.every(Number.isFinite)
		? { x: parts[0], y: parts[1], zoom: parts[2] }
		: undefined
}

/** What the Mount reports; the zoom buttons are view events. */
type MountMessage = Extract<
	Message,
	{
		readonly _tag:
			| "ChangedViewport"
			| "ResizedPane"
			| "MeasuredNodes"
			| "DraggedNode"
			| "EndedNodeDrag"
			| "EndedViewportMove"
	}
>

const HANDLE_SIDES = new Set(["top", "right", "bottom", "left"])

const isSide = (value: string | null): value is HandleBounds["position"] =>
	value !== null && HANDLE_SIDES.has(value)

/** `getHandleBounds` + `getDimensions` from @xyflow/system, for one `.react-flow__node`. */
const measureNode = (node: HTMLElement, zoom: number): MeasuredNode | undefined => {
	const id = node.getAttribute("data-id")
	if (id === null || node.offsetWidth === 0 || node.offsetHeight === 0) return undefined
	const nodeRect = node.getBoundingClientRect()
	const handles: HandleBounds[] = []
	for (const handle of node.querySelectorAll<HTMLElement>(".react-flow__handle")) {
		const position = handle.getAttribute("data-handlepos")
		if (!isSide(position)) continue
		const rect = handle.getBoundingClientRect()
		handles.push({
			type: handle.classList.contains("source") ? "source" : "target",
			position,
			x: (rect.left - nodeRect.left) / zoom,
			y: (rect.top - nodeRect.top) / zoom,
			width: handle.offsetWidth,
			height: handle.offsetHeight,
		})
	}
	return { id, width: node.offsetWidth, height: node.offsetHeight, handles }
}

const sameMeasurement = (a: MeasuredNode | undefined, b: MeasuredNode): boolean =>
	a !== undefined &&
	a.width === b.width &&
	a.height === b.height &&
	a.handles.length === b.handles.length &&
	a.handles.every((handle, index) => handle.x === b.handles[index].x && handle.y === b.handles[index].y)

/** Measures nodes as they appear or resize, batching each observer callback into one Message. */
const observeNodes = (renderer: HTMLElement, emit: (message: MountMessage) => void) => {
	const last = new Map<string, MeasuredNode>()
	// `updateNodeInternals` reads the zoom from the viewport's computed transform, not the store.
	const zoomNow = () => {
		const viewport = renderer.querySelector(".xyflow__viewport")
		return viewport === null ? 1 : new DOMMatrixReadOnly(getComputedStyle(viewport).transform).m22
	}
	const measure = (nodes: Iterable<HTMLElement>) => {
		const changed: MeasuredNode[] = []
		for (const node of nodes) {
			const measured = measureNode(node, zoomNow())
			if (measured === undefined || sameMeasurement(last.get(measured.id), measured)) continue
			last.set(measured.id, measured)
			changed.push(measured)
		}
		if (changed.length > 0) emit(Message.MeasuredNodes({ nodes: changed }))
	}
	const resizes = new ResizeObserver((entries) =>
		measure(entries.flatMap((entry) => (entry.target instanceof HTMLElement ? [entry.target] : []))),
	)
	const observed = new WeakSet<Element>()
	const observeNew = () => {
		for (const node of renderer.querySelectorAll<HTMLElement>(".react-flow__node")) {
			if (observed.has(node)) continue
			observed.add(node)
			resizes.observe(node)
		}
	}
	const additions = new MutationObserver(observeNew)
	additions.observe(renderer, { childList: true, subtree: true })
	observeNew()
	// The Model bumps the epoch to have every node measured again at the zoom of this moment.
	const remeasure = new MutationObserver(() =>
		measure(renderer.querySelectorAll<HTMLElement>(".react-flow__node")),
	)
	remeasure.observe(renderer, { attributes: true, attributeFilter: [MEASURE_EPOCH_ATTRIBUTE] })
	return () => {
		remeasure.disconnect()
		additions.disconnect()
		resizes.disconnect()
	}
}

/** `ZoomPane`: XYPanZoom on the renderer with React Flow's default gesture options. */
const attachPanZoom = (
	system: typeof import("@xyflow/system"),
	renderer: HTMLElement,
	limits: { readonly minZoom: number; readonly maxZoom: number },
	emit: (message: MountMessage) => void,
) => {
	const panZoom = system.XYPanZoom({
		domNode: renderer,
		minZoom: limits.minZoom,
		maxZoom: limits.maxZoom,
		translateExtent: system.infiniteExtent,
		viewport: readViewport(renderer) ?? { x: 0, y: 0, zoom: 1 },
		onDraggingChange: () => {},
		onPanZoomEnd: () => emit(Message.EndedViewportMove()),
	})
	panZoom.update({
		noWheelClassName: "nowheel",
		noPanClassName: "nopan",
		preventScrolling: true,
		panOnScroll: false,
		panOnDrag: true,
		panOnScrollMode: system.PanOnScrollMode.Free,
		panOnScrollSpeed: 0.5,
		userSelectionActive: false,
		zoomOnPinch: true,
		zoomOnScroll: true,
		zoomOnDoubleClick: true,
		zoomActivationKeyPressed: false,
		lib: "react",
		connectionInProgress: false,
		paneClickDistance: 1,
		selectionOnDrag: false,
		onTransformChange: ([x, y, zoom]) => emit(Message.ChangedViewport({ viewport: { x, y, zoom } })),
	})
	// The Model moves the camera too (fit, zoom buttons); hand d3 the rendered camera before it reads its own.
	const sync = () => {
		const viewport = readViewport(renderer)
		if (viewport !== undefined) panZoom.syncViewport(viewport)
	}
	const gestures = ["wheel", "mousedown", "touchstart", "dblclick"] as const
	for (const type of gestures) renderer.addEventListener(type, sync, { capture: true })
	// An animated fit runs as React Flow's does: one d3 transition, every frame back as a Message.
	const started = { seq: Number.NaN }
	const animations = new MutationObserver(() => {
		const leaf = renderer.querySelector(".react-flow__viewport-portal")
		const parts = (leaf?.getAttribute(ANIMATION_ATTRIBUTE) ?? "").split(",").map(Number)
		if (parts.length !== 5 || !parts.every(Number.isFinite) || parts[0] === started.seq) return
		started.seq = parts[0]
		sync()
		void panZoom.setViewport({ x: parts[1], y: parts[2], zoom: parts[3] }, { duration: parts[4] })
	})
	animations.observe(renderer, { attributes: true, subtree: true, attributeFilter: [ANIMATION_ATTRIBUTE] })
	return () => {
		animations.disconnect()
		for (const type of gestures) renderer.removeEventListener(type, sync, { capture: true })
		panZoom.destroy()
	}
}

/** A node wrapper's flow position, read back from its `translate(x, y)`. */
const nodeOrigin = (node: HTMLElement): XY => {
	const match = node.style.transform.match(/translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/)
	return match === null ? { x: 0, y: 0 } : { x: Number(match[1]), y: Number(match[2]) }
}

/**
 * `XYDrag` on `.react-flow__node.draggable`: React Flow's pointer math (the pointer in flow space
 * minus where the node was grabbed), its 1 px start threshold, and d3-drag's click suppression
 * once the mouse moved, so a drag never also selects the node.
 */
const attachNodeDrag = (renderer: HTMLElement, emit: (message: MountMessage) => void) => {
	const container = renderer.parentElement ?? renderer
	const pointerAt = (event: MouseEvent): XY => {
		const viewport = readViewport(renderer) ?? { x: 0, y: 0, zoom: 1 }
		const bounds = container.getBoundingClientRect()
		return {
			x: (event.clientX - bounds.left - viewport.x) / viewport.zoom,
			y: (event.clientY - bounds.top - viewport.y) / viewport.zoom,
		}
	}
	const swallowClick = (event: MouseEvent) => {
		event.stopPropagation()
		event.preventDefault()
	}
	const onDown = (event: MouseEvent) => {
		if (event.button !== 0 || !(event.target instanceof Element)) return
		if (event.target.closest(".nodrag") !== null) return
		const node = event.target.closest<HTMLElement>(".react-flow__node.draggable")
		const id = node?.getAttribute("data-id")
		if (node === null || node === undefined || id === null || id === undefined) return
		const origin = nodeOrigin(node)
		const start = pointerAt(event)
		const grab = { x: start.x - origin.x, y: start.y - origin.y }
		const state = { moved: false, dragging: false, position: origin }
		const move = (moveEvent: MouseEvent) => {
			const pointer = pointerAt(moveEvent)
			state.moved =
				state.moved || moveEvent.clientX !== event.clientX || moveEvent.clientY !== event.clientY
			if (!state.dragging && Math.hypot(pointer.x - start.x, pointer.y - start.y) <= 1) return
			state.dragging = true
			state.position = { x: pointer.x - grab.x, y: pointer.y - grab.y }
			emit(Message.DraggedNode({ id, position: state.position }))
		}
		const up = () => {
			window.removeEventListener("mousemove", move)
			window.removeEventListener("mouseup", up)
			if (state.dragging) emit(Message.EndedNodeDrag({ id, position: state.position }))
			if (!state.moved) return
			window.addEventListener("click", swallowClick, { capture: true, once: true })
			setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0)
		}
		window.addEventListener("mousemove", move)
		window.addEventListener("mouseup", up)
	}
	renderer.addEventListener("mousedown", onDown)
	return () => renderer.removeEventListener("mousedown", onDown)
}

/** Pane size from the renderer, which fills the `.react-flow` wrapper. */
const observePane = (renderer: HTMLElement, emit: (message: MountMessage) => void) => {
	const report = () =>
		emit(Message.ResizedPane({ width: renderer.offsetWidth, height: renderer.offsetHeight }))
	const observer = new ResizeObserver(report)
	observer.observe(renderer)
	return () => observer.disconnect()
}

/**
 * The imperative half of `<ReactFlow>` on `.react-flow__renderer`: d3-zoom gestures, pane size and
 * node measurement. Everything it learns returns as canvas Messages; the view renders the camera.
 */
export const AttachFlowCanvas = Mount.defineStream("AttachFlowCanvas", {
	args: { minZoom: Schema.Number, maxZoom: Schema.Number },
	messages: [
		Message.ChangedViewport,
		Message.ResizedPane,
		Message.MeasuredNodes,
		Message.DraggedNode,
		Message.EndedNodeDrag,
		Message.EndedViewportMove,
	],
	execute: ({ element, minZoom, maxZoom }) =>
		Stream.callback<MountMessage>((queue) =>
			Effect.acquireRelease(
				Effect.promise(() => import("@xyflow/system")).pipe(
					Effect.map((system) => {
						if (!(element instanceof HTMLElement)) return () => {}
						const emit = (message: MountMessage) => Queue.offerUnsafe(queue, message)
						const releases = [
							observePane(element, emit),
							observeNodes(element, emit),
							attachPanZoom(system, element, { minZoom, maxZoom }, emit),
							attachNodeDrag(element, emit),
						]
						return () => releases.forEach((release) => release())
					}),
				),
				(release) => Effect.sync(release),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
