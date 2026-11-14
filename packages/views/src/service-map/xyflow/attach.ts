import * as XYSystem from "@xyflow/system"
import { Effect, Option, Queue, Schema, Stream, Array as Arr, String as Str } from "effect"
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
	const parts = Arr.map(Str.split(",")(leaf?.getAttribute(VIEWPORT_ATTRIBUTE) ?? ""), Number)
	const [x, y, zoom] = parts
	return parts.length === 3 &&
		x !== undefined &&
		y !== undefined &&
		zoom !== undefined &&
		Arr.every(parts, Number.isFinite)
		? { x, y, zoom }
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
	const handles = Arr.flatMap(
		Array.from(node.querySelectorAll<HTMLElement>(".react-flow__handle")),
		(handle): ReadonlyArray<HandleBounds> => {
			const position = handle.getAttribute("data-handlepos")
			if (!isSide(position)) return []
			const rect = handle.getBoundingClientRect()
			return [
				{
					type: handle.classList.contains("source") ? "source" : "target",
					position,
					x: (rect.left - nodeRect.left) / zoom,
					y: (rect.top - nodeRect.top) / zoom,
					width: handle.offsetWidth,
					height: handle.offsetHeight,
				},
			]
		},
	)
	return { id, width: node.offsetWidth, height: node.offsetHeight, handles }
}

const sameMeasurement = (a: MeasuredNode | undefined, b: MeasuredNode): boolean =>
	a !== undefined &&
	a.width === b.width &&
	a.height === b.height &&
	a.handles.length === b.handles.length &&
	Arr.every(
		a.handles,
		(handle, index) => handle.x === b.handles[index]?.x && handle.y === b.handles[index]?.y,
	)

/** Measures nodes as they appear or resize, batching each observer callback into one Message. */
const observeNodes = (renderer: HTMLElement, emit: (message: MountMessage) => void) => {
	const last = new Map<string, MeasuredNode>()
	// `updateNodeInternals` reads the zoom from the viewport's computed transform, not the store.
	const zoomNow = () => {
		const viewport = renderer.querySelector(".xyflow__viewport")
		return viewport === null ? 1 : new DOMMatrixReadOnly(getComputedStyle(viewport).transform).m22
	}
	const measure = (nodes: Iterable<HTMLElement>) => {
		const changed = Arr.flatMap(Array.from(nodes), (node): ReadonlyArray<MeasuredNode> => {
			const measured = measureNode(node, zoomNow())
			if (measured === undefined || sameMeasurement(last.get(measured.id), measured)) return []
			last.set(measured.id, measured)
			return [measured]
		})
		if (changed.length > 0) emit(Message.MeasuredNodes({ nodes: changed }))
	}
	const resizes = new ResizeObserver((entries) =>
		measure(Arr.flatMap(entries, (entry) => (entry.target instanceof HTMLElement ? [entry.target] : []))),
	)
	const observed = new WeakSet<Element>()
	const observeNew = () => {
		renderer.querySelectorAll<HTMLElement>(".react-flow__node").forEach((node) => {
			if (observed.has(node)) return
			observed.add(node)
			resizes.observe(node)
		})
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

const Point = Schema.Tuple([Schema.Number, Schema.Number])

/** `<ReactFlow>` gesture props a canvas may change; React Flow's defaults otherwise. */
export const FlowGestures = Schema.Struct({
	panOnScroll: Schema.Boolean,
	zoomOnScroll: Schema.Boolean,
	zoomOnDoubleClick: Schema.Boolean,
	/** `preventScrolling`: `false` leaves the wheel to the page. */
	preventScrolling: Schema.Boolean,
	/** `translateExtent` as `[[x0, y0], [x1, y1]]`; `null` is unbounded. */
	translateExtent: Schema.NullOr(Schema.Tuple([Point, Point])),
})
export type FlowGestures = typeof FlowGestures.Type

export const DEFAULT_GESTURES: FlowGestures = {
	panOnScroll: false,
	zoomOnScroll: true,
	zoomOnDoubleClick: true,
	preventScrolling: true,
	translateExtent: null,
}

/** The zoom limits and gestures, live props on `<ReactFlow>`: the renderer carries them as JSON. */
export const LIMITS_ATTRIBUTE = "data-flow-limits"

export const FlowLimits = Schema.Struct({
	minZoom: Schema.Number,
	maxZoom: Schema.Number,
	gestures: FlowGestures,
})
export type FlowLimits = typeof FlowLimits.Type

const FlowLimitsJson = Schema.fromJsonString(FlowLimits)

export const limitsAttribute = (limits: FlowLimits): string => Schema.encodeSync(FlowLimitsJson)(limits)

/** Applies the renderer's limits when they differ from the last applied value; returns the applied value. */
export const followLimits = (
	raw: string | null,
	applied: string,
	apply: (limits: FlowLimits) => void,
): string =>
	raw === null || raw === applied
		? applied
		: Option.match(Schema.decodeOption(FlowLimitsJson)(raw), {
				onNone: () => applied,
				onSome: (limits) => {
					apply(limits)
					return raw
				},
			})

/** `ZoomPane`: XYPanZoom on the renderer with the canvas's gesture options. */
const attachPanZoom = (
	system: typeof XYSystem,
	renderer: HTMLElement,
	limits: FlowLimits,
	emit: (message: MountMessage) => void,
) => {
	const extentOf = (gestures: FlowGestures): [[number, number], [number, number]] =>
		gestures.translateExtent === null
			? system.infiniteExtent
			: [
					[gestures.translateExtent[0][0], gestures.translateExtent[0][1]],
					[gestures.translateExtent[1][0], gestures.translateExtent[1][1]],
				]
	const panZoom = system.XYPanZoom({
		domNode: renderer,
		minZoom: limits.minZoom,
		maxZoom: limits.maxZoom,
		translateExtent: extentOf(limits.gestures),
		viewport: readViewport(renderer) ?? { x: 0, y: 0, zoom: 1 },
		onDraggingChange: () => {},
		onPanZoomEnd: () => emit(Message.EndedViewportMove()),
	})
	const updateGestures = (gestures: FlowGestures) =>
		panZoom.update({
			noWheelClassName: "nowheel",
			noPanClassName: "nopan",
			preventScrolling: gestures.preventScrolling,
			panOnScroll: gestures.panOnScroll,
			panOnDrag: true,
			panOnScrollMode: system.PanOnScrollMode.Free,
			panOnScrollSpeed: 0.5,
			userSelectionActive: false,
			zoomOnPinch: true,
			zoomOnScroll: gestures.zoomOnScroll,
			zoomOnDoubleClick: gestures.zoomOnDoubleClick,
			zoomActivationKeyPressed: false,
			lib: "react",
			connectionInProgress: false,
			paneClickDistance: 1,
			selectionOnDrag: false,
			onTransformChange: ([x, y, zoom]) => emit(Message.ChangedViewport({ viewport: { x, y, zoom } })),
		})
	updateGestures(limits.gestures)
	// React Flow re-applies these props on every change; follow the renderer's attribute.
	const applied = { value: limitsAttribute(limits) }
	const limitChanges = new MutationObserver(() => {
		applied.value = followLimits(renderer.getAttribute(LIMITS_ATTRIBUTE), applied.value, (next) => {
			panZoom.setScaleExtent([next.minZoom, next.maxZoom])
			panZoom.setTranslateExtent(extentOf(next.gestures))
			updateGestures(next.gestures)
		})
	})
	limitChanges.observe(renderer, { attributes: true, attributeFilter: [LIMITS_ATTRIBUTE] })
	// The Model moves the camera too (fit, zoom buttons); hand d3 the rendered camera before it reads its own.
	const sync = () => {
		const viewport = readViewport(renderer)
		if (viewport !== undefined) panZoom.syncViewport(viewport)
	}
	const gestureEvents = ["wheel", "mousedown", "touchstart", "dblclick"] as const
	Arr.forEach(gestureEvents, (type) => renderer.addEventListener(type, sync, { capture: true }))
	// An animated fit runs as React Flow's does: one d3 transition, every frame back as a Message.
	const started = { seq: Number.NaN }
	const animations = new MutationObserver(() => {
		const leaf = renderer.querySelector(".react-flow__viewport-portal")
		const parts = Arr.map(Str.split(",")(leaf?.getAttribute(ANIMATION_ATTRIBUTE) ?? ""), Number)
		const [seq, x, y, zoom, duration] = parts
		if (
			parts.length !== 5 ||
			seq === undefined ||
			x === undefined ||
			y === undefined ||
			zoom === undefined ||
			duration === undefined ||
			!Arr.every(parts, Number.isFinite) ||
			seq === started.seq
		)
			return
		started.seq = seq
		sync()
		void panZoom.setViewport({ x, y, zoom }, { duration })
	})
	animations.observe(renderer, { attributes: true, subtree: true, attributeFilter: [ANIMATION_ATTRIBUTE] })
	return () => {
		animations.disconnect()
		limitChanges.disconnect()
		Arr.forEach(gestureEvents, (type) => renderer.removeEventListener(type, sync, { capture: true }))
		panZoom.destroy()
	}
}

/** A node wrapper's flow position, read back from its `translate(x, y)`. */
const nodeOrigin = (node: HTMLElement): XY => {
	return Option.match(Str.match(/translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/)(node.style.transform), {
		onNone: () => ({ x: 0, y: 0 }),
		onSome: (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
	})
}

type DragTarget = Pick<Window, "addEventListener" | "removeEventListener">
type DragListener = (event: MouseEvent) => void

/** The drag in progress, whose window listeners outlive the mousedown; `stop` drops them. */
export const windowDrag = (target: DragTarget) => {
	const active = { stop: () => {} }
	const stop = () => active.stop()
	const start = (move: DragListener, up: DragListener) => {
		stop()
		target.addEventListener("mousemove", move)
		target.addEventListener("mouseup", up)
		active.stop = () => {
			target.removeEventListener("mousemove", move)
			target.removeEventListener("mouseup", up)
			active.stop = () => {}
		}
	}
	return { start, stop }
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
	const drag = windowDrag(window)
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
		const state = {
			moved: false,
			dragging: false,
			position: origin,
			grab: { x: 0, y: 0 },
			last: { x: Number.NaN, y: Number.NaN },
		}
		const move = (moveEvent: MouseEvent) => {
			const pointer = pointerAt(moveEvent)
			state.moved =
				state.moved || moveEvent.clientX !== event.clientX || moveEvent.clientY !== event.clientY
			// The threshold is in client pixels; the drag starts from where the pointer crossed it.
			if (!state.dragging) {
				if (Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) <= 1)
					return
				state.dragging = true
				state.grab = { x: pointer.x - origin.x, y: pointer.y - origin.y }
				state.last = pointer
				return
			}
			if (pointer.x === state.last.x && pointer.y === state.last.y) return
			state.last = pointer
			state.position = { x: pointer.x - state.grab.x, y: pointer.y - state.grab.y }
			emit(Message.DraggedNode({ id, position: state.position }))
		}
		const up = () => {
			drag.stop()
			if (state.dragging) emit(Message.EndedNodeDrag({ id, position: state.position }))
			if (!state.moved) return
			window.addEventListener("click", swallowClick, { capture: true, once: true })
			// @effect-diagnostics-next-line globalTimers:off -- DOM pointer handler; drops the listener after this click
			setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0)
		}
		drag.start(move, up)
	}
	renderer.addEventListener("mousedown", onDown)
	// An unmount mid-drag also drops the drag's window listeners.
	return () => {
		renderer.removeEventListener("mousedown", onDown)
		drag.stop()
	}
}

/** Pane size from the renderer, which fills the `.react-flow` wrapper. */
const observePane = (renderer: HTMLElement, emit: (message: MountMessage) => void) => {
	const report = () =>
		emit(
			Message.ResizedPane({
				width: renderer.offsetWidth,
				height: renderer.offsetHeight,
				extent: {
					width: renderer.getBoundingClientRect().width,
					height: renderer.getBoundingClientRect().height,
				},
			}),
		)
	const observer = new ResizeObserver(report)
	observer.observe(renderer)
	return () => observer.disconnect()
}

/**
 * The imperative half of `<ReactFlow>` on `.react-flow__renderer`: d3-zoom gestures, pane size and
 * node measurement. Everything it learns returns as canvas Messages; the view renders the camera.
 */
export const AttachFlowCanvas = Mount.defineStream("AttachFlowCanvas", {
	args: { minZoom: Schema.Number, maxZoom: Schema.Number, gestures: FlowGestures },
	messages: [
		Message.ChangedViewport,
		Message.ResizedPane,
		Message.MeasuredNodes,
		Message.DraggedNode,
		Message.EndedNodeDrag,
		Message.EndedViewportMove,
	],
	execute: ({ element, minZoom, maxZoom, gestures }) =>
		Stream.callback<MountMessage>((queue) =>
			Effect.acquireRelease(
				Effect.succeed(XYSystem).pipe(
					Effect.map((system) => {
						if (!(element instanceof HTMLElement)) return () => {}
						const emit = (message: MountMessage) => Queue.offerUnsafe(queue, message)
						const releases = [
							observePane(element, emit),
							observeNodes(element, emit),
							attachPanZoom(system, element, { minZoom, maxZoom, gestures }, emit),
							attachNodeDrag(element, emit),
						]
						return () => Arr.forEach(releases, (release) => release())
					}),
				),
				(release) => Effect.sync(release),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
