import { patternSearchTerm } from "../../lib/log-patterns"
import * as ToggleGroup from "@maple/web/ui/toggle-group"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { idle } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import type { updateCopy } from "../kit/copies"
import { type LogsCommand, ReadClock } from "./command"
import { LogsComposition } from "./composition"
import { filtersOf, modeOf } from "./filters"
import { load } from "./load"
import type { Message } from "./message"
import type { Model } from "./model"
import type { WaitChipDelay } from "./update-chips"

/** Every Command the page's own update returns. */
export type PageCommand =
	| LogsCommand
	| ReturnType<typeof WaitChipDelay>
	| ReturnType<typeof updateCopy<Message>>["commands"][number]

/** A result without an ask to the root, so it can be combined with the Bindings' operations. */
export type StepReturn = Readonly<{ model: Model; commands?: ReadonlyArray<PageCommand> }>
export type UpdateReturn = StepReturn & Readonly<{ outMessage?: PageOutMessage }>

export const MODE_LABEL = "Logs view"

/** The page's own fields; the filter sections and the card's tooltip start from their Bindings. */
type PageFields = Omit<Model, "sections" | "chipJsonTooltip">

/** The filter sections, the log sheet's absence and the card's tooltip are assembled by their Bindings. */
export const init = LogsComposition.makeInit((context: PageContext) => {
	const query = queryOf(context.location)
	const q = query.get("q") ?? ""
	const model: PageFields = {
		_tag: "LogsPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		logs: idle(),
		isFetchingNextPage: false,
		pageGeneration: 0,
		logsUpdatedAtMs: 0,
		patternsUpdatedAtMs: 0,
		patterns: idle(),
		services: idle(),
		severities: idle(),
		viewport: { scrollTop: 0, height: 0 },
		search: { text: q, version: 0, sent: q },
		modeToggle: ToggleGroup.initialModel({ label: MODE_LABEL, values: [modeOf(query)] }),
		maybeDetail: Option.none(),
		isRefreshing: false,
		copies: {},
		chipCard: { visible: Option.none(), pendingOpen: Option.none(), pendingClose: Option.none(), generation: 0, isJsonExpanded: false },
	}
	return { model, commands: [ReadClock()] }
})

/** The hash changed: sync the search input (unless it is our own echo), then request. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	const q = query.get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	// Each mode is its own component in legacy: leaving the list unmounts its detail sheet.
	const maybeDetail = modeOf(query) === "list" ? model.maybeDetail : Option.none()
	return load({ ...model, search, maybeDetail }, context)
}

export const navigate = (model: Model, context: PageContext, updates: Record<string, string | null>): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

export const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** `onSelect`: a pattern opens the list searching its longest literal token. */
export const selectPattern = (model: Model, context: PageContext, template: string): UpdateReturn => {
	const filters = filtersOf(queryOf(context.location))
	return navigate(model, context, { mode: null, q: patternSearchTerm(template) || filters.search || null })
}

/** The refresh spinner stops once nothing the refresh started is still loading. */
export const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	const busy = [model.logs.data, model.patterns.data, model.services.data, model.severities.data].some(isLoading)
	return model.isRefreshing && !busy ? { ...model, isRefreshing: false } : model
}
