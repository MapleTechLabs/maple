import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { Option, Result } from "effect"
import { Update } from "foldkit"
import { initAndSet } from "foldkit/bindingInit"
import { accept } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage } from "../contract"
import { updateCopy } from "../kit/copies"
import { CopyChip, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { ChipJsonTooltipBinding, LogSheetBinding, LogsComposition } from "./composition"
import { makeNoopStep, makeStep } from "./definition"
import { modeOf } from "./filters"
import { load } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { appendPage, loadMoreIfAtEnd, rowsOf } from "./stream"
import { locationChanged, navigate, selectPattern, setRange, settleRefresh, type StepReturn, type UpdateReturn } from "./update"
import {
	closeChip,
	elapseDelay,
	enterCard,
	isSameVisible,
	leaveCard,
	leaveChip,
	scheduleOpen,
	toggleChipJson,
	withCard,
} from "./update-chips"
import { updateFetch, updateFound } from "./update-fetch"
import { virtualWindow } from "./virtualize"

/** A card whose row scrolled out of the virtual window goes with it. */
const dropScrolledCard = (model: Model): Model => {
	const rendered = new Set(virtualWindow(rowsOf(model).length, model.viewport))
	return withCard(model, { ...model.chipCard, visible: Option.filter(model.chipCard.visible, (chip) => rendered.has(chip.index)) })
}

const debounceSearch = (model: Model, text: string): StepReturn => {
	const version = model.search.version + 1
	return { model: { ...model, search: { ...model.search, text, version } }, commands: [WaitSearchDebounce({ version })] }
}

/** A step that may change the shown card: a new card (or none) starts its tooltip over. */
const cardStep = (step: (model: Model) => StepReturn) =>
	makeStep((model) => {
		const next = step(model)
		return Update.combineSteps([
			makeStep(() => next),
			isSameVisible(model.chipCard.visible, next.model.chipCard.visible)
				? makeNoopStep()
				: ChipJsonTooltipBinding.requestReset(),
		])
	})

/** The mode toggle is controlled by the hash: a press on the other mode navigates. */
const chooseMode = (model: Model, context: PageContext, value: string): UpdateReturn =>
	value === modeOf(queryOf(context.location))
		? { model }
		: navigate(model, context, { mode: value === "patterns" ? "patterns" : null })

export const update = LogsComposition.makeUpdate.withContext((context: PageContext) => {
	const query = queryOf(context.location)
	return {
		CompletedReadClock: (model, { nowMs }) => load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchLogs: (model, fields) => updateFetch(model, Message.SucceededFetchLogs(fields), context),
		FailedFetchLogs: (model, fields) => updateFetch(model, Message.FailedFetchLogs(fields), context),
		FoundCachedLogs: (model, fields) => updateFound(model, Message.FoundCachedLogs(fields), context),
		FoundCachedPatterns: (model, fields) => updateFound(model, Message.FoundCachedPatterns(fields), context),
		FoundCachedServices: (model, fields) => updateFound(model, Message.FoundCachedServices(fields), context),
		FoundCachedSeverities: (model, fields) => updateFound(model, Message.FoundCachedSeverities(fields), context),
		SucceededFetchNextPage: (model, { key, generation, page }) =>
			generation === model.pageGeneration ? loadMoreIfAtEnd(appendPage(model, key, page), context) : { model },
		FailedFetchNextPage: (model, { key, generation, failure }) =>
			generation !== model.pageGeneration
				? { model }
				: { model: { ...model, isFetchingNextPage: false, logs: accept(model.logs, key, Result.fail(failure)) } },
		SucceededFetchPatterns: (model, fields) => updateFetch(model, Message.SucceededFetchPatterns(fields), context),
		FailedFetchPatterns: (model, fields) => updateFetch(model, Message.FailedFetchPatterns(fields), context),
		SucceededFetchServices: (model, { key, options, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.succeed(options), fetchedAtMs) }) }),
		FailedFetchServices: (model, { key, failure }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.fail(failure)) }) }),
		SucceededFetchSeverities: (model, { key, options, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.succeed(options), fetchedAtMs) }) }),
		FailedFetchSeverities: (model, { key, failure }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.fail(failure)) }) }),
		ChangedViewport: (model, { viewport }) =>
			cardStep((current) => loadMoreIfAtEnd(dropScrolledCard({ ...current, viewport }), context))(model),
		ClickedOpenFilters: (model) => ({ model, outMessage: PageOutMessage.RequestedFilterDrawer() }),
		ClickedRefresh: (model) =>
			model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: (model, { nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
			const refetch = load({ ...model, nowMs }, context, true)
			return { model: settleRefresh(refetch.model), commands: refetch.commands, outMessage: PageOutMessage.RefetchedInPlace() }
		},
		ChangedSearch: (model, { text }) => debounceSearch(model, text),
		ClickedClearSearch: (model) => debounceSearch(model, ""),
		ElapsedSearchDebounce: (model, { version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledFacetOption: (model, { param, name }) => navigate(model, context, { [param]: query.get(param) === name ? null : name }),
		ClickedClearSidebarFilters: (model) => navigate(model, context, { service: null, severity: null }),
		ClickedClearFilters: (model) => navigate(model, context, { service: null, severity: null, q: null }),
		ChangedRange: (model, { range }) => setRange(model, context, range),
		ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
		ChoseMode: (model, { value }) => chooseMode(model, context, value),
		ClickedPattern: (model, { pattern }) => selectPattern(model, context, pattern.template),
		ClickedLog: (model, { log }) =>
			Option.isNone(model.maybeDetail)
				? initAndSet(LogSheetBinding, model, { args: [log] })
				: LogSheetBinding.requestShowLog({ log })(model),
		ClickedChip: (model, { text }) => ({ model, commands: [CopyChip({ text })] }),
		CompletedCopyChip: (model) => ({ model }),
		EnteredChip: (model, { chip }) => cardStep((current) => scheduleOpen(current, chip))(model),
		FocusedChip: (model, { chip }) => cardStep((current) => scheduleOpen(current, chip))(model),
		LeftChip: (model, { chip }) => cardStep((current) => leaveChip(current, chip))(model),
		BlurredChip: (model, { chip }) => cardStep((current) => closeChip(current, chip))(model),
		PressedChipEscape: (model, { chip }) => cardStep((current) => closeChip(current, chip))(model),
		EnteredChipCard: (model) => cardStep((current) => enterCard(current))(model),
		LeftChipCard: (model) => cardStep((current) => leaveCard(current))(model),
		ElapsedChipDelay: (model, { generation }) => cardStep((current) => elapseDelay(current, generation))(model),
		PlacedChipCard: (model) => ({ model }),
		ClickedChipJson: (model) => toggleChipJson(model),
		ReceivedCopyMessage: (model, { message: copy }) => {
			const next = updateCopy(model.copies, copy, (message) => Message.ReceivedCopyMessage({ message }))
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
		InformedOfLocationChange: (model) => locationChanged(model, context),
	}
})

