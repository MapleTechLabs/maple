import { changedItems, type Layout, sameLayout } from "@maple/grid-engine"
import type { DashboardDocument } from "@maple/domain/http"
import type { PageContext, PageReturn } from "../../contract"
import { withLayouts } from "../kit/layout"
import { UpdateWidgetLayouts } from "./command"
import { gridOfWidget } from "./grid"
import type { Message } from "./message"
import type { LayoutChange, LayoutWrite, Model } from "./model"
import { Array as Arr } from "effect"

type Return = PageReturn<Model, Message>

const send = (
	model: Model,
	context: PageContext,
	write: Readonly<{ key: string; layout: Layout; changes: ReadonlyArray<LayoutChange> }>,
): Return => {
	const generation = model.nextLayoutGeneration
	return {
		model: {
			...model,
			nextLayoutGeneration: generation + 1,
			layoutWrite: { _tag: "Saving", generation, key: write.key, layout: write.layout, changes: write.changes },
		},
		commands: [
			UpdateWidgetLayouts({
				orgId: context.orgId,
				dashboardId: model.dashboardId,
				generation,
				layouts: write.changes,
			}),
		],
	}
}

/** `finish`: a changed layout is one write of the tiles that moved; the grid keeps drawing it. */
export const commitLayout = (
	model: Model,
	context: PageContext,
	widgetId: string,
	origin: Layout,
	final: Layout,
): Return => {
	const grid = gridOfWidget(model, widgetId)
	if (grid === null || sameLayout(final, origin)) return { model }
	// Tiles a write in flight moved are written again: dropping one back must undo that write too.
	const pending = model.layoutWrite?._tag === "Saving" ? model.layoutWrite.changes : []
	const movedIds = new Set(Arr.map(changedItems(grid.stored, final), ({ i }) => i))
	const changes = Arr.map(
		Arr.filter(final, ({ i }) => movedIds.has(i) || Arr.some(pending, (change) => change.i === i)),
		({ i, x, y, w, h }) => ({ i, x, y, w, h }),
	)
	if (changes.length === 0) {
		const generation = model.nextLayoutGeneration
		const layoutWrite: LayoutWrite = { _tag: "Saved", generation, key: grid.key, layout: final, changes }
		return { model: { ...model, nextLayoutGeneration: generation + 1, layoutWrite } }
	}
	return send(model, context, { key: grid.key, layout: final, changes })
}

/** A drop's write settled: a failure draws the stored layout again. `null`: a later drop superseded it. */
export const settleLayoutWrite = (
	model: Model,
	generation: number,
	isSaved: boolean,
	document: DashboardDocument | null,
): Model | null => {
	if (generation !== model.nextLayoutGeneration - 1) return null
	const write = model.layoutWrite
	if (write === null || write._tag !== "Saving" || write.generation !== generation) return model
	if (!isSaved) return { ...model, layoutWrite: { ...write, _tag: "Failed" } }
	return { ...model, layoutWrite: isEchoed(write, document) ? null : { ...write, _tag: "Saved" } }
}

/** Retry sends the failed drop again, and the grid draws it while it saves. */
export const retryLayoutWrite = (model: Model, context: PageContext): Return =>
	model.layoutWrite !== null && model.layoutWrite._tag === "Failed"
		? send(model, context, model.layoutWrite)
		: { model }

const isEchoed = (write: LayoutWrite, document: DashboardDocument | null): boolean =>
	document !== null && withLayouts(document, write.changes, document.updatedAt) === null

/** A new document clears a drop once the store holds it, or the write is settled; a save keeps drawing. */
export const receiveLayoutWrite = (write: LayoutWrite | null, document: DashboardDocument): LayoutWrite | null =>
	write === null || write._tag === "Saved" || isEchoed(write, document) ? null : write
