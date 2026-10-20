import type { V2Investigation } from "@maple/domain/http/v2"
import { buildProvenanceGraph, type ProvenanceGraph } from "@maple/web-data/investigations/provenance-graph"
import { modifyFields } from "foldkit/struct"
import type { Model } from "./model"

// The camera arithmetic of the provenance canvas.

const MIN_FIT = 0.68
const FIT_PADDING = 0.06
/** Room above the graph for the column headings, which sit 20px over their column. */
export const HEADING_GUTTER = 28
/** Room below it for the control bar, which overlaps the canvas's bottom-left corner. */
export const CONTROL_GUTTER = 34

/** The causal chain the canvas draws: pure arithmetic over the investigation, cheap to rebuild. */
export const graphOf = (investigation: V2Investigation, timeZone: string): ProvenanceGraph =>
	buildProvenanceGraph(investigation, timeZone)

/** The zoom the placement settles on for a pane this wide; floored so the verdict words stay words. */
export const fitScale = (paneWidth: number, graph: ProvenanceGraph): number =>
	paneWidth > 0 ? Math.min(1, Math.max(MIN_FIT, (paneWidth * (1 - FIT_PADDING * 2)) / graph.width)) : 1

/**
 * `place()`: centre the graph, or anchor it left once the zoom clamps so the cause stays on screen.
 * A reader who moved the camera keeps it.
 */
export const placeGraph = (model: Model, timeZone: string): Model => {
	if (model.sync._tag !== "Ready" || model.canvas.movedByUser || model.canvas.pane.width <= 0) return model
	const graph = graphOf(model.sync.investigation, timeZone)
	const width = model.canvas.pane.width
	const zoom = fitScale(width, graph)
	const drawn = graph.width * zoom
	const viewport = { x: drawn > width ? width * FIT_PADDING : (width - drawn) / 2, y: HEADING_GUTTER * zoom, zoom }
	return modifyFields(model, { canvas: (canvas) => ({ ...canvas, viewport }) })
}
