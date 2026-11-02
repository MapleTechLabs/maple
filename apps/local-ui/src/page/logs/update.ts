import type { Resources } from "../../platform/resources"
import { patternSearchTerm } from "../../lib/log-patterns"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import * as Popover from "@maple/views/ui/popover"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import * as Tooltip from "@maple/views/ui/tooltip"
import { Option } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { idle } from "@maple/views/data/keyed"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, type ParamUpdates, replaceParams, withParams } from "../contract"
import { ReadClock, ReadPreferences } from "./command"
import { columnsOf, filtersOf, modeOf } from "./filters"
import { load } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { syncStream } from "./update-stream"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>
export type InitReturn = Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }>

export const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

export const MODE_LABEL = "Logs view"

export const init = (context: PageContext): InitReturn => {
	const query = queryOf(context.location)
	const q = query.get("q") ?? ""
	return {
		model: {
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
			stream: LogsStream.init("local-logs", []),
			columns: columnsOf(query),
			columnOptions: [],
			wrap: false,
			density: "compact",
			toolbarTooltip: Tooltip.init("logs-toolbar-tooltip"),
			columnsPopover: Popover.init("logs-columns-popover", { align: "end" }),
			search: { text: q, version: 0, sent: q },
			modeToggle: ToggleGroup.init({ label: MODE_LABEL, values: [modeOf(query)] }),
			sections: FilterSections.init(),
			maybeDetail: Option.none(),
			isRefreshing: false,
			copies: {},
		},
		commands: [ReadClock(), ReadPreferences(), Command.mapMessage(FilterSections.ReadRemembered(), toSections)],
	}
}

/** The hash changed: sync the search input (unless it is our own echo), then request. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	const q = query.get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	// Each mode is its own component in legacy: leaving the list unmounts its detail sheet.
	const maybeDetail = modeOf(query) === "list" ? model.maybeDetail : Option.none()
	return syncStream(model, load({ ...model, search, maybeDetail }, context), context)
}

export const navigate = (model: Model, context: PageContext, updates: ParamUpdates): UpdateReturn => ({
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
