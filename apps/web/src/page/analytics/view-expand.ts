import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "../../ui/dialog-view"
import { dialogDescription, dialogHeader, dialogTitle } from "../../ui/dialog-view"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersOf } from "./requests"
import { panelOf } from "./update"
import { crawledPagesCard, aiDialogTable } from "./view-ai"
import { breakdownTable, dimensionTabs, panelFilterInput, panelView } from "./view-breakdown"
import { overviewCards } from "./view-overview"

// The expand dialogs of `AnalyticsBreakdownPanel` and `AiPanel`: one dialog, whichever card opened it.

type H = HtmlBuilder<Message>

const DIALOG_CLASS = "w-[900px] max-w-[92vw] gap-0 p-0 max-sm:w-full"

const cardsOf = (model: Model) => {
	const crawlers = Option.getOrUndefined(AsyncData.getData(model.aiCrawlers.data))
	return [...overviewCards(model), ...(crawlers === undefined ? [] : [crawledPagesCard(model, crawlers)])]
}

const breakdownContent = (h: H, model: Model, panelId: string): ReadonlyArray<Html> | null => {
	const card = cardsOf(model).find((candidate) => candidate.id === panelId)
	if (card === undefined) return null
	const state = panelOf(model, card.id)
	const view = panelView(state, card.dimensions)
	if (view === null) return null
	const { dimension, hasViews } = view
	const id = model.expandDialog.id
	const ranking = hasViews
		? (dimension.viewsLabel?.toLowerCase() ?? "page views")
		: (dimension.countLabel?.toLowerCase() ?? "sessions")
	return [
		dialogHeader(h, "dialog", [
			h.div([h.Class("flex flex-col gap-1 pe-8")], [
				dialogTitle(h, "dialog", id, dimension.tab, "text-base"),
				dialogDescription(h, "dialog", id, [
					"Ranked by",
					" ",
					ranking,
					" ",
					"over the selected window. Pick a row to filter the page.",
				]),
			]),
			h.div([h.Class("flex flex-wrap items-center justify-between gap-x-3 gap-y-2")], [
				dimensionTabs(h, card.id, card.dimensions, view.activeTab),
				panelFilterInput(h, card.id, state.query, dimension.nounPlural, "w-56", "-dialog", true),
			]),
		], "gap-3 pb-3"),
		breakdownTable(h, model, card.id, view, {
			maxHeight: "min(62vh, 640px)",
			surfaceClass: "bg-popover",
			isRanked: true,
			selected: filtersOf(model.search)[dimension.filterKey],
			isWaiting: false,
		}),
	]
}

const aiContent = (h: H, model: Model, panelId: string, timeZone: string): ReadonlyArray<Html> | null => {
	const table = aiDialogTable(h, model, panelId, timeZone)
	if (table === null) return null
	const id = model.expandDialog.id
	return [
		dialogHeader(h, "dialog", [
			h.div([h.Class("flex flex-col gap-1 pe-8")], [
				dialogTitle(h, "dialog", id, table.title, "text-base"),
				dialogDescription(h, "dialog", id, table.hint),
			]),
		], "pb-3"),
		h.div([h.Class("@container/panel")], [table.table]),
	]
}

const contentOf = (h: H, model: Model, timeZone: string, _close: ReadonlyArray<ChildAttribute>): ReadonlyArray<Html> => {
	const panelId = model.expandedPanel
	if (panelId === null) return []
	return breakdownContent(h, model, panelId) ?? aiContent(h, model, panelId, timeZone) ?? []
}

/** The dialog's portal while open or closing. */
export const expandDialog = (h: H, model: Model, timeZone: string): Html =>
	h.submodel({
		slotId: "analytics-expand-dialog",
		model: model.expandDialog,
		view: DialogView.view,
		viewInputs: {
			className: DIALOG_CLASS,
			hasTrigger: false,
			hasDescription: true,
			toView: ({ portal }) => portal,
			toContent: (close) => contentOf(h, model, timeZone, close),
		},
		toParentMessage: (message) => Message.GotExpandDialogMessage({ message }),
	})
