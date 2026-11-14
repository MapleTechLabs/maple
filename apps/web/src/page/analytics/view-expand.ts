import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "@maple/views/ui/dialog-view"
import { dialogDescription, dialogHeader, dialogTitle } from "@maple/views/ui/dialog-view"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersOf } from "./requests"
import { panelOf } from "./update"
import { crawledPagesCard, aiDialogTable } from "./view-ai"
import { breakdownTable, dimensionTabs, panelFilterInput, panelView } from "./view-breakdown"
import { overviewCards } from "./view-overview"
import { isSearchPanel, searchDialogTable } from "./view-search"
import { hstack, vstack } from "@maple/views/ui/stack"

// One expand dialog for the breakdown, AI and Search cards, whichever card opened it.

type H = HtmlBuilder<Message>

/** The Search tables carry up to seven figure columns beside the name, so their dialog is wider. */
const dialogClass = (isWide: boolean): string =>
	cn("max-w-[92vw] gap-0 p-0 max-sm:w-full", isWide ? "w-[1080px]" : "w-[900px]")

const cardsOf = (model: Model) => {
	const crawlers = Option.getOrUndefined(AsyncData.getData(model.aiCrawlers.data))
	return [...overviewCards(model), ...(crawlers === undefined ? [] : [crawledPagesCard(model, crawlers)])]
}

const breakdownContent = (h: H, model: Model, panelId: string): ReadonlyArray<Html> | null => {
	const found = Arr.findFirst(cardsOf(model), (candidate) => candidate.id === panelId)
	if (Option.isNone(found)) return null
	const card = found.value
	const state = panelOf(model, card.id)
	const view = panelView(state, card.dimensions)
	if (view === null) return null
	const { dimension, hasViews } = view
	const id = model.expandDialog.id
	const ranking = hasViews
		? dimension.viewsLabel === undefined
			? "page views"
			: Str.toLowerCase(dimension.viewsLabel)
		: dimension.countLabel === undefined
			? "sessions"
			: Str.toLowerCase(dimension.countLabel)
	return [
		dialogHeader(
			h,
			"dialog",
			[
				vstack(h, { gap: "1", className: "pe-8" }, [
					dialogTitle(h, "dialog", id, dimension.tab, "text-base"),
					dialogDescription(h, "dialog", id, [
						"Ranked by",
						" ",
						ranking,
						" ",
						"over this window. Pick a row to filter the page.",
					]),
				]),
				hstack(h, { justify: "between", wrap: true, className: "gap-x-3 gap-y-2" }, [
					dimensionTabs(h, card.id, card.dimensions, view.activeTab),
					panelFilterInput(h, card.id, state.query, dimension.nounPlural, "w-56", "-dialog", true),
				]),
			],
			"gap-3 pb-3",
		),
		breakdownTable(h, model, card.id, view, {
			maxHeight: "min(62vh, 640px)",
			surfaceClass: "bg-popover",
			isRanked: true,
			selected: filtersOf(model.search)[dimension.filterKey],
			isWaiting: false,
		}),
	]
}

/** An AI or Search card's table: its title and hint, a filter when the card has one, then the table. */
const cardContent = (h: H, model: Model, panelId: string, timeZone: string): ReadonlyArray<Html> | null => {
	const table: Readonly<{ title: string; hint: string; table: Html; filter?: Html }> | null =
		aiDialogTable(h, model, panelId, timeZone) ?? searchDialogTable(h, model, panelId)
	if (table === null) return null
	const id = model.expandDialog.id
	return [
		dialogHeader(
			h,
			"dialog",
			[
				vstack(h, { gap: "1", className: "pe-8" }, [
					dialogTitle(h, "dialog", id, table.title, "text-base"),
					dialogDescription(h, "dialog", id, [table.hint]),
				]),
				...(table.filter === undefined ? [] : [hstack(h, { justify: "end" }, [table.filter])]),
			],
			table.filter === undefined ? "pb-3" : "gap-3 pb-3",
		),
		h.div([h.Class("@container/panel")], [table.table]),
	]
}

const contentOf = (
	h: H,
	model: Model,
	timeZone: string,
	_close: ReadonlyArray<ChildAttribute>,
): ReadonlyArray<Html> => {
	const panelId = model.expandedPanel
	if (panelId === null) return []
	return breakdownContent(h, model, panelId) ?? cardContent(h, model, panelId, timeZone) ?? []
}

/** The dialog's portal while open or closing. */
export const expandDialog = (h: H, model: Model, timeZone: string): Html =>
	h.submodel({
		slotId: "analytics-expand-dialog",
		model: model.expandDialog,
		view: DialogView.view,
		viewInputs: {
			className: dialogClass(isSearchPanel(model.expandedPanel)),
			hasTrigger: false,
			hasDescription: true,
			toView: ({ portal }) => portal,
			toContent: (close) => contentOf(h, model, timeZone, close),
		},
		toParentMessage: (message) => Message.GotExpandDialogMessage({ message }),
	})
