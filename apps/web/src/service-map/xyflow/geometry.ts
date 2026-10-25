import { Schema } from "effect"

/** React Flow's camera: screen = flow * zoom + (x, y). */
export const Viewport = Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number })
export type Viewport = typeof Viewport.Type

export const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

export const HandleSide = Schema.Literals(["top", "right", "bottom", "left"])
export type HandleSide = typeof HandleSide.Type

/** A handle's box relative to its node, as React Flow's `getHandleBounds` measures it. */
export const HandleBounds = Schema.Struct({
	type: Schema.Literals(["source", "target"]),
	position: HandleSide,
	x: Schema.Number,
	y: Schema.Number,
	width: Schema.Number,
	height: Schema.Number,
})
export type HandleBounds = typeof HandleBounds.Type

/** `offsetWidth/offsetHeight` of a node wrapper plus its handles. */
export const MeasuredNode = Schema.Struct({
	id: Schema.String,
	width: Schema.Number,
	height: Schema.Number,
	handles: Schema.Array(HandleBounds),
})
export type MeasuredNode = typeof MeasuredNode.Type

/** A flow-space point as a Schema (`XY` for Messages). */
export const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number })

export interface XY {
	readonly x: number
	readonly y: number
}

export interface Rect extends XY {
	readonly width: number
	readonly height: number
}

/** A node as the canvas needs it: where it sits and what was measured for it. */
export interface PlacedNode {
	readonly id: string
	readonly position: XY
	readonly measured: MeasuredNode | undefined
}

/** `getHandlePosition` from @xyflow/system for a measured handle. */
export const handlePoint = (node: PlacedNode, handle: HandleBounds): XY => {
	const x = node.position.x + handle.x
	const y = node.position.y + handle.y
	switch (handle.position) {
		case "top":
			return { x: x + handle.width / 2, y }
		case "right":
			return { x: x + handle.width, y: y + handle.height / 2 }
		case "bottom":
			return { x: x + handle.width / 2, y: y + handle.height }
		case "left":
			return { x, y: y + handle.height / 2 }
	}
}
