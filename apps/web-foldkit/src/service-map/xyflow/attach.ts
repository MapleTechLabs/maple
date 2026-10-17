import { Effect, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import { Message } from "./canvas"
import type { HandleBounds, MeasuredNode, Viewport } from "./geometry"

/** The renderer carries the Model's camera here so d3-zoom can be synced before a gesture. */
export const VIEWPORT_ATTRIBUTE = "data-viewport"

/** Bumped by the Model (`Canvas.remeasure`) to re-measure every node. */
export const MEASURE_EPOCH_ATTRIBUTE = "data-measure-epoch"

export const viewportAttribute = (viewport: Viewport): string =>
	`${viewport.x},${viewport.y},${viewport.zoom}`

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
type MountMessage = Extract<Message, { readonly _tag: "ChangedViewport" | "ResizedPane" | "MeasuredNodes" }>

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
	return () => {
		for (const type of gestures) renderer.removeEventListener(type, sync, { capture: true })
		panZoom.destroy()
	}
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
	messages: [Message.ChangedViewport, Message.ResizedPane, Message.MeasuredNodes],
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
						]
						return () => releases.forEach((release) => release())
					}),
				),
				(release) => Effect.sync(release),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
