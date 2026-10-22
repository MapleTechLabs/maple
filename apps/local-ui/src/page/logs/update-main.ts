import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import * as ToggleGroup from "@maple/web/ui/toggle-group"
import { Option, Result } from "effect"
import { Command } from "foldkit"
import { accept } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage } from "../contract"
import { updateCopy } from "../kit/copies"
import { CopyChip, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { modeOf } from "./filters"
import { load } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { appendPage, loadMoreIfAtEnd, rowsOf } from "./stream"
import { navigate, selectPattern, setRange, settleRefresh, toSections, type UpdateReturn } from "./update"
import * as LogSheet from "../kit/log-sheet/update"
import {
	closeChip,
	elapseDelay,
	enterCard,
	leaveCard,
	leaveChip,
	scheduleOpen,
	toggleChipJson,
	updateChipJsonTooltip,
	withCard,
} from "./update-chips"
import { updateFetch, updateFound } from "./update-fetch"
import { virtualWindow } from "./virtualize"

/** A card whose row scrolled out of the virtual window goes with it. */
const dropScrolledCard = (model: Model): Model => {
	const rendered = new Set(virtualWindow(rowsOf(model).length, model.viewport))
	return withCard(model, { ...model.chipCard, visible: Option.filter(model.chipCard.visible, (chip) => rendered.has(chip.index)) })
}

/** Folds a sheet step into the page. */
const liftSheet = (model: Model, step: LogSheet.UpdateReturn): UpdateReturn => ({
	model: { ...model, maybeDetail: Option.some(step.model) },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotLogSheetMessage({ message })),
})

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

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	return Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) => load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchLogs: (fields) => updateFetch(model, Message.SucceededFetchLogs(fields), context),
		FailedFetchLogs: (fields) => updateFetch(model, Message.FailedFetchLogs(fields), context),
		FoundCachedLogs: (fields) => updateFound(model, Message.FoundCachedLogs(fields), context),
		FoundCachedPatterns: (fields) => updateFound(model, Message.FoundCachedPatterns(fields), context),
		FoundCachedServices: (fields) => updateFound(model, Message.FoundCachedServices(fields), context),
		FoundCachedSeverities: (fields) => updateFound(model, Message.FoundCachedSeverities(fields), context),
		SucceededFetchNextPage: ({ key, generation, page }) =>
			generation === model.pageGeneration ? loadMoreIfAtEnd(appendPage(model, key, page), context) : { model },
		FailedFetchNextPage: ({ key, generation, failure }) =>
			generation !== model.pageGeneration
				? { model }
				: { model: { ...model, isFetchingNextPage: false, logs: accept(model.logs, key, Result.fail(failure)) } },
		SucceededFetchPatterns: (fields) => updateFetch(model, Message.SucceededFetchPatterns(fields), context),
		FailedFetchPatterns: (fields) => updateFetch(model, Message.FailedFetchPatterns(fields), context),
		SucceededFetchServices: ({ key, options, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.succeed(options), fetchedAtMs) }) }),
		FailedFetchServices: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.fail(failure)) }) }),
		SucceededFetchSeverities: ({ key, options, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.succeed(options), fetchedAtMs) }) }),
		FailedFetchSeverities: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.fail(failure)) }) }),
		ChangedViewport: ({ viewport }) => loadMoreIfAtEnd(dropScrolledCard({ ...model, viewport }), context),
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
		ClickedClearFilters: () => navigate(model, context, { service: null, severity: null, q: null }),
		ChangedRange: ({ range }) => setRange(model, context, range),
		ClickedWidenRange: () => setRange(model, context, WIDEST_RANGE),
		GotModeToggleMessage: ({ message: child }) => foldModeToggle(model, context, child),
		ClickedPattern: ({ pattern }) => selectPattern(model, context, pattern.template),
		ClickedLog: ({ log }) => liftSheet(model, LogSheet.openLog(model.maybeDetail, log)),
		ClickedChip: ({ text }) => ({ model, commands: [CopyChip({ text })] }),
		CompletedCopyChip: () => ({ model }),
		EnteredChip: ({ chip }) => scheduleOpen(model, chip),
		FocusedChip: ({ chip }) => scheduleOpen(model, chip),
		LeftChip: ({ chip }) => leaveChip(model, chip),
		BlurredChip: ({ chip }) => closeChip(model, chip),
		PressedChipEscape: ({ chip }) => closeChip(model, chip),
		EnteredChipCard: () => enterCard(model),
		LeftChipCard: () => leaveCard(model),
		ElapsedChipDelay: ({ generation }) => elapseDelay(model, generation),
		PlacedChipCard: () => ({ model }),
		ClickedChipJson: () => toggleChipJson(model),
		GotChipJsonTooltipMessage: ({ message: child }) => updateChipJsonTooltip(model, child),
		GotLogSheetMessage: ({ message: child }) =>
			Option.match(model.maybeDetail, { onNone: () => ({ model }), onSome: (sheet) => liftSheet(model, LogSheet.update(sheet, child)) }),
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

