import { changedItems, type Layout, sameLayout } from "@maple/grid-engine"
import type { PageContext, PageReturn } from "../../contract"
import { UpdateWidgetLayouts } from "./command"
import { gridOfWidget } from "./grid"
import type { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>

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
	const changed = changedItems(grid.stored, final)
	if (changed.length === 0) return { model: { ...model, droppedLayout: final, droppedKey: grid.key } }
	return {
		model: { ...model, droppedLayout: final, droppedKey: grid.key },
		commands: [
			UpdateWidgetLayouts({
				orgId: context.orgId,
				dashboardId: model.dashboardId,
				layouts: changed.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
			}),
		],
	}
}
