import type { WorldCell } from "@maple/domain/http"
import { cellToScene, sameCell, sceneToCell } from "../factory/grid"
import { selectTool, type Tool, type ToolContext, type ToolPointer } from "./tools"

// Customize mode's pointer tool: press a building, drag it over free cells, drop to place it.
// A press that never leaves its cell is an ordinary click, so selection works as in select.

export interface Placement {
	/** Whether `nodeId`'s building fits at `cell`, ignoring its own footprint. */
	readonly canPlace: (nodeId: string, cell: WorldCell) => boolean
	/** The building's cell now, `null` for a node the world does not draw. */
	readonly cellOf: (nodeId: string) => WorldCell | null
	/** The drop: called once per drag that ends on a new, free cell. */
	readonly onMove: (nodeId: string, cell: WorldCell) => void
}

interface Drag {
	readonly nodeId: string
	readonly from: WorldCell
	to: WorldCell
}

interface DragState {
	drag: Drag | null
}

/** Bit 1 of `buttons` is the primary button, whichever button an event reports. */
const isPrimaryHeld = (event: ToolPointer) => (event.buttons & 1) === 1

const cellUnder = (event: ToolPointer, context: ToolContext): WorldCell | null => {
	const hit = context.pickGround(event)
	return hit === null ? null : sceneToCell([hit.x, 0, hit.z])
}

export const moveTool = (placement: () => Placement): Tool => {
	const select = selectTool()
	const state: DragState = { drag: null }
	const release = (context: ToolContext) => {
		state.drag = null
		context.holdPan(false)
	}
	const drop = (context: ToolContext) => {
		const drag = state.drag
		if (drag === null) return
		release(context)
		// The preview stays until the scene rebuilds at the new cell, so the drop never flickers.
		if (sameCell(drag.from, drag.to)) context.previewMachine(drag.nodeId, null)
		else placement().onMove(drag.nodeId, drag.to)
	}
	/** The drag ends without a drop: the building goes back where it stood. */
	const abandon = (context: ToolContext) => {
		if (state.drag !== null) context.previewMachine(state.drag.nodeId, null)
		release(context)
	}
	return {
		cursor: "grab",
		pointerDown: (event, context) => {
			select.pointerDown?.(event, context)
			if (event.button !== 0) return
			const nodeId = context.pickMachines(event)[0]
			if (nodeId === undefined) return
			const from = placement().cellOf(nodeId)
			if (from === null) return
			state.drag = { nodeId, from, to: from }
			context.holdPan(true)
		},
		pointerMove: (event, context) => {
			const drag = state.drag
			if (drag === null) return
			// The left button came up while another stays down: no pointerup fires, so drop here.
			if (!isPrimaryHeld(event)) return drop(context)
			const cell = cellUnder(event, context)
			// Off the ground or onto another building: the ghost stays at the last free cell.
			if (cell === null || sameCell(cell, drag.to) || !placement().canPlace(drag.nodeId, cell)) return
			drag.to = cell
			context.previewMachine(drag.nodeId, cellToScene(cell))
		},
		pointerUp: (event, context) => {
			if (state.drag !== null && !isPrimaryHeld(event)) drop(context)
		},
		click: (event, context) => select.click?.(event, context),
		pointerCancel: (context) => abandon(context),
		deactivate: (context) => abandon(context),
	}
}
