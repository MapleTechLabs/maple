import { snapToMinute, WIDEST_RANGE } from "@maple/local-ui/lib/time"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import * as ToggleGroup from "@maple/web-foldkit/ui/toggle-group"
import { Option, Result } from "effect"
import { Command } from "foldkit"
import { accept } from "../../data/slot"
import { queryOf } from "../../route"
import type { PageContext } from "../contract"
import { updateCopy } from "../kit/copies"
import { CopyChip, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { modeOf } from "./filters"
import { load } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { appendPage, loadMoreIfAtEnd, openDetail } from "./stream"
import { navigate, selectPattern, setRange, settleRefresh, toSections, type UpdateReturn } from "./update"
import { closeDetail, foldAttributes, foldTabs, toggleBody } from "./update-detail"
import { updateFetch } from "./update-fetch"

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
		SucceededFetchNextPage: ({ key, page }) => loadMoreIfAtEnd(appendPage(model, key, page), context),
		FailedFetchNextPage: ({ key, failure }) => ({
			model: { ...model, isFetchingNextPage: false, logs: accept(model.logs, key, Result.fail(failure)) },
		}),
		SucceededFetchPatterns: (fields) => updateFetch(model, Message.SucceededFetchPatterns(fields), context),
		FailedFetchPatterns: (fields) => updateFetch(model, Message.FailedFetchPatterns(fields), context),
		SucceededFetchServices: ({ key, options }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.succeed(options)) }) }),
		FailedFetchServices: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, services: accept(model.services, key, Result.fail(failure)) }) }),
		SucceededFetchSeverities: ({ key, options }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.succeed(options)) }) }),
		FailedFetchSeverities: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, severities: accept(model.severities, key, Result.fail(failure)) }) }),
		ChangedViewport: ({ viewport }) => loadMoreIfAtEnd({ ...model, viewport }, context),
		ClickedRefresh: () =>
			model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: ({ nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
			const refetch = load({ ...model, nowMs }, context, true)
			return { model: settleRefresh(refetch.model), commands: refetch.commands }
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
		ClickedLog: ({ log }) => ({ model: { ...model, maybeDetail: Option.some(openDetail(model.maybeDetail, log)) } }),
		ClickedChip: ({ text }) => ({ model, commands: [CopyChip({ text })] }),
		CompletedCopyChip: () => ({ model }),
		ClosedDetail: () => closeDetail(model),
		ToggledBodyExpanded: () => toggleBody(model),
		GotDetailTabsMessage: ({ message: child }) => foldTabs(model, child),
		GotDetailAttributesMessage: ({ message: child }) => foldAttributes(model, child),
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

