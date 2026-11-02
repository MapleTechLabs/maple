import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as Popover from "@maple/views/ui/popover"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import * as Tooltip from "@maple/views/ui/tooltip"
import { Option, Result } from "effect"
import { Command } from "foldkit"
import { accept } from "@maple/views/data/keyed"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage } from "../contract"
import { updateCopy } from "../kit/copies"
import { ReadRefreshClock, SavePreferences, WaitSearchDebounce } from "./command"
import { columnsOf, filtersOf, modeOf, withoutAttributeFilter } from "./filters"
import { load } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { navigate, selectPattern, setRange, settleRefresh, toSections, type UpdateReturn } from "./update"
import * as LogSheet from "@maple/views/logs/log-sheet"
import { updateFetch, updateFound } from "./update-fetch"
import { appendPage, foldStream, liftSheet, syncStream } from "./update-stream"

/** Wrap and density are saved as soon as they change. */
const savePreferences = (model: Model): UpdateReturn => ({
	model,
	commands: [SavePreferences({ preferences: { wrap: model.wrap, density: model.density } })],
})

/** One child Submodel step folded into the page. */
const lift = <Child, ChildMessage>(
	step: Readonly<{ model: Child; commands?: ReadonlyArray<Command.Command<ChildMessage>> }>,
	write: (child: Child) => Model,
	toMessage: (message: ChildMessage) => Message,
): UpdateReturn => ({ model: write(step.model), commands: Command.mapMessages(step.commands ?? [], toMessage) })

const debounceSearch = (model: Model, text: string): UpdateReturn => {
	const version = model.search.version + 1
	return { model: { ...model, search: { ...model.search, text, version } }, commands: [WaitSearchDebounce({ version })] }
}

/** The mode toggle is controlled by the hash: a press on the other mode navigates. */
const foldModeToggle = (model: Model, context: PageContext, message: ToggleGroup.Message): UpdateReturn => {
	const next = ToggleGroup.update(model.modeToggle, message)
	const withToggle = {
		...model,
		modeToggle: next.model,
	}
	const commands = Command.mapMessages(next.commands ?? [], (toggle) => Message.GotModeToggleMessage({ message: toggle }))
	if (message._tag !== "ClickedItem" || message.value === modeOf(queryOf(context.location)))
		return { model: withToggle, commands }
	const step = navigate(withToggle, context, { mode: message.value === "patterns" ? "patterns" : null })
	return { ...step, commands }
}

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	syncStream(model, updatePage(model, message, context), context)

const updatePage = (model: Model, message: Message, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	return Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) => load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchLogs: (fields) => updateFetch(model, Message.SucceededFetchLogs(fields)),
		FailedFetchLogs: (fields) => updateFetch(model, Message.FailedFetchLogs(fields)),
		FoundCachedLogs: (fields) => updateFound(model, Message.FoundCachedLogs(fields), context),
		FoundCachedPatterns: (fields) => updateFound(model, Message.FoundCachedPatterns(fields), context),
		FoundCachedServices: (fields) => updateFound(model, Message.FoundCachedServices(fields), context),
		FoundCachedSeverities: (fields) => updateFound(model, Message.FoundCachedSeverities(fields), context),
		SucceededFetchNextPage: ({ key, generation, page }) =>
			generation === model.pageGeneration ? { model: appendPage(model, key, page) } : { model },
		FailedFetchNextPage: ({ key, generation, failure }) =>
			generation !== model.pageGeneration
				? { model }
				: { model: { ...model, isFetchingNextPage: false, logs: accept(model.logs, key, Result.fail(failure)) } },
		SucceededFetchPatterns: (fields) => updateFetch(model, Message.SucceededFetchPatterns(fields)),
		FailedFetchPatterns: (fields) => updateFetch(model, Message.FailedFetchPatterns(fields)),
		SucceededFetchServices: ({ key, options, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.succeed(options), fetchedAtMs) }) }),
		FailedFetchServices: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.fail(failure)) }) }),
		SucceededFetchSeverities: ({ key, options, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.succeed(options), fetchedAtMs) }) }),
		FailedFetchSeverities: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.fail(failure)) }) }),
		GotStreamMessage: ({ message: child }) => foldStream(model, child, context),
		ClickedOpenFilters: () => ({ model, outMessage: PageOutMessage.RequestedFilterDrawer() }),
		ClickedRefresh: () =>
			model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: ({ nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
			const refetch = load({ ...model, nowMs }, context, true)
			return { model: settleRefresh(refetch.model), commands: refetch.commands, outMessage: PageOutMessage.RefetchedInPlace() }
		},
		ChangedSearch: ({ text }) => debounceSearch(model, text),
		ClickedClearSearch: () => debounceSearch(model, ""),
		ElapsedSearchDebounce: ({ version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledFacetOption: ({ param, name }) => navigate(model, context, { [param]: query.get(param) === name ? null : name }),
		ClickedClearSidebarFilters: () => navigate(model, context, { service: null, severity: null }),
		ClickedClearFilters: () => navigate(model, context, { service: null, severity: null, q: null, attrs: null }),
		RemovedAttributeFilter: (removed) =>
			navigate(model, context, { attrs: withoutAttributeFilter(filtersOf(query), removed) }),
		ToggledColumn: ({ key }) => {
			const pinned = columnsOf(query)
			return navigate(model, context, { columns: pinned.includes(key) ? pinned.filter((other) => other !== key) : [...pinned, key] })
		},
		ClickedWrap: () => savePreferences({ ...model, wrap: !model.wrap }),
		ClickedDensity: () => savePreferences({ ...model, density: model.density === "compact" ? "comfortable" : "compact" }),
		CompletedReadPreferences: ({ preferences }) => ({ model: { ...model, ...preferences } }),
		CompletedSavePreferences: () => ({ model }),
		GotToolbarTooltipMessage: ({ message: child }) =>
			lift(Tooltip.update(model.toolbarTooltip, child), (toolbarTooltip) => ({ ...model, toolbarTooltip }), (tip) =>
				Message.GotToolbarTooltipMessage({ message: tip }),
			),
		GotColumnsPopoverMessage: ({ message: child }) =>
			lift(Popover.update(model.columnsPopover, child), (columnsPopover) => ({ ...model, columnsPopover }), (popover) =>
				Message.GotColumnsPopoverMessage({ message: popover }),
			),
		ChangedRange: ({ range }) => setRange(model, context, range),
		ClickedWidenRange: () => setRange(model, context, WIDEST_RANGE),
		GotModeToggleMessage: ({ message: child }) => foldModeToggle(model, context, child),
		ClickedPattern: ({ pattern }) => selectPattern(model, context, pattern.template),
		GotLogSheetMessage: ({ message: child }) =>
			Option.match(model.maybeDetail, { onNone: () => ({ model }), onSome: (sheet) => liftSheet(model, LogSheet.update(sheet, child), context) }),
		GotFilterSectionsMessage: ({ message: child }) => {
			const next = FilterSections.update(model.sections, child)
			return { model: { ...model, sections: next.model }, commands: Command.mapMessages(next.commands ?? [], toSections) }
		},
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) => Message.GotCopyMessage({ id: copyId, message: copyMessage }))
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
	})
}

