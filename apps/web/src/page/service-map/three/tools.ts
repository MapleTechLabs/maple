import { DRAG_TOLERANCE } from "../../../components/service-map/three/scene-input"
import type * as THREE from "three"
import type { Size } from "./camera"
import type { DuckClick } from "./critters"
import type { Vec3 } from "./kit"

// Pointer tools: the scene forwards canvas pointer events to the active tool, which reads the
// world through `ToolContext`. Selection is a tool; customize mode will add placement tools.

/** The pointer fields a tool reads; DOM pointer and mouse events satisfy it. */
export type ToolPointer = Pick<MouseEvent, "clientX" | "clientY" | "offsetX" | "offsetY" | "button">

export interface ToolContext {
	readonly camera: THREE.Camera
	readonly size: () => Size
	/** Machine ids under the pointer, nearest first. */
	readonly pickMachines: (event: ToolPointer) => ReadonlyArray<string>
	/** The duck under the pointer's click, if any. */
	readonly pickDuck: (event: ToolPointer) => (() => DuckClick) | null
	/** Where the pointer meets the ground plane y = 0. */
	readonly pickGround: (event: ToolPointer) => THREE.Vector3 | null
	readonly selectedId: () => string | null
	readonly select: (id: string | null) => void
	readonly quack: (count: number) => void
	/** Keeps drawing every frame for `ms`, for motion on a paused map. */
	readonly wake: (ms: number) => void
	readonly invalidate: () => void
	/** Moves a machine without a rebuild; `null` restores its layout position. */
	readonly previewMachine: (id: string, position: Vec3 | null) => void
	/** Suspends camera panning while a tool drags an object. */
	readonly holdPan: (held: boolean) => void
}

export interface Tool {
	/** The CSS cursor over the canvas while the tool is active. */
	readonly cursor: string
	readonly pointerDown?: (event: ToolPointer, context: ToolContext) => void
	readonly pointerMove?: (event: ToolPointer, context: ToolContext) => void
	readonly pointerUp?: (event: ToolPointer, context: ToolContext) => void
	/** The browser took the pointer away (a touch gesture, a system dialog): abandon, never commit. */
	readonly pointerCancel?: (context: ToolContext) => void
	readonly click?: (event: ToolPointer, context: ToolContext) => void
	/** Undo any preview or held pan when another tool takes over. */
	readonly deactivate?: (context: ToolContext) => void
}

/**
 * R3F's click semantics: a miss within 2 px (and the canvas's own 5 px check) clears the
 * selection; a machine click must start on that machine and travel at most DRAG_TOLERANCE.
 */
export const selectTool = (): Tool => {
	const pressed = { x: 0, y: 0, offsetX: 0, offsetY: 0, hits: new Array<string>() }
	return {
		cursor: "",
		pointerDown: (event, context) => {
			pressed.x = event.clientX
			pressed.y = event.clientY
			pressed.offsetX = event.offsetX
			pressed.offsetY = event.offsetY
			pressed.hits = [...context.pickMachines(event)]
		},
		click: (event, context) => {
			const hits = context.pickMachines(event)
			const delta = Math.hypot(event.offsetX - pressed.offsetX, event.offsetY - pressed.offsetY)
			const first = hits[0]
			if (first === undefined) {
				const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y)
				const duck = moved <= DRAG_TOLERANCE ? context.pickDuck(event) : null
				const clicked = duck === null ? null : duck()
				if (clicked !== null) {
					context.quack(clicked.alarm ? 3 : 2)
					// Keep drawing for the whole hop or take-off on a paused map, at any refresh rate.
					context.wake(clicked.seconds * 1000 + 50)
					return
				}
				if (delta <= 2 && moved <= DRAG_TOLERANCE) context.select(null)
				return
			}
			if (!pressed.hits.includes(first) || delta > DRAG_TOLERANCE) return
			context.select(context.selectedId() === first ? null : first)
		},
	}
}
