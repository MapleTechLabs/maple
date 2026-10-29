import { isLocalSessionLive } from "../../lib/session-liveness"
import { cn } from "@maple/ui/lib/utils"
import * as CopyButton from "@maple/web/ui/copy-button"
import { listFooter } from "@maple/web/ui/list-footer"
import { Array, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { hrefFor, queryOf } from "../../route"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { refreshButton, timeRangeSelect, toolbar, toolbarSearch, toolbarStat, toolbarStats } from "../kit/toolbar"
import { errorState, listSkeleton } from "../kit/view-states"
import { CopiesBinding, GUIDE_ID, type SessionsViewBuilder, SessionsComposition } from "./composition"
import { filtersOf } from "./fetch"
import { Message } from "./message"
import type { Model } from "./model"
import { sessionCard } from "./view-card"
import { sidebar } from "./view-sidebar"

// The sessions list page.

/** One of the connect guide's copy buttons, embedded from its keyed slot. */
const embedCopy = (h: SessionsViewBuilder, model: Model) => (id: string, viewInputs: CopyButton.CopyButtonViewInputs): Html =>
	Option.match(
		Array.findFirst(model.copies, (slot) => slot.id === id),
		{
			onNone: () => null,
			onSome: (slot) => h.block(CopiesBinding.embedView({ key: slot.id, slotId: `copy-${slot.id}`, model: slot.copy, viewInputs })),
		},
	)

export const view = SessionsComposition.makeView.withInputs<PageViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const query = queryOf(context.location)
	const filters = filtersOf(query)
	const range = rangeOf(context)
	const activeFilterCount = [filters.service, filters.browser, filters.device, filters.errorsOnly].filter(Boolean).length
	const hasActiveFilters = activeFilterCount > 0
	const maybeData = AsyncData.getData(model.sessions.data)
	const sessions = Option.match(maybeData, { onNone: () => [], onSome: (data) => data.pages.flat() })
	const hasNextPage = Option.exists(maybeData, (data) => data.hasNextPage)
	const content = (): Html => {
		if (isPending(model.sessions)) return listSkeleton(h, { variant: "card", rows: 6 })
		const failure = failureWithoutData(model.sessions)
		if (Option.isSome(failure))
			return errorState(h, { label: "sessions", failure: failure.value, onRetry: Message.ClickedRefresh() })
		if (sessions.length === 0)
			return signalEmptyState(h, {
				signal: "sessions",
				isFiltered: hasActiveFilters || filters.search !== undefined,
				onClearFilters: Message.ClickedClearAllFilters(),
				range,
				onWidenRange: Message.ClickedWidenRange(),
				maybePresence: inputs.presenceOf("sessions"),
				nowMs: inputs.presenceNowMs,
				guide: { id: GUIDE_ID, endpoint: context.env.otlpEndpoint, embedCopy: embedCopy(h, model) },
			})
		const footer = listFooter(h, {
			hasMore: hasNextPage,
			isLoading: model.isFetchingNextPage,
			onLoadMore: Message.ClickedLoadMore(),
			className: "pb-0",
		})
		return h.div(
			[h.Class(cn("p-4", model.sessions.isPlaceholder && "opacity-60 transition-opacity"))],
			[
				h.div(
					[h.Class("space-y-2")],
					sessions.map((session) =>
						sessionCard(h, session, hrefFor(`/sessions/${encodeURIComponent(session.sessionId)}`, query), model.nowMs, context.timeFormat),
					),
				),
				...(footer === null ? [] : [footer]),
			],
		)
	}
	const bar = toolbar(h, [
		toolbarSearch(h, {
			id: "sessions-search",
			value: model.search.text,
			placeholder: "Search by URL…",
			onInput: (text) => Message.ChangedSearch({ text }),
			onClear: Message.ClickedClearSearch(),
			className: "min-w-48 flex-1",
		}),
		toolbarStats(
			h,
			[
				toolbarStat(h, { value: sessions.length, label: hasNextPage ? "sessions+" : "sessions" }),
				toolbarStat(h, {
					value: sessions.filter((session) => isLocalSessionLive(session, model.nowMs)).length,
					label: "active",
					hasDot: true,
				}),
				refreshButton(h, {
					isSpinning: model.isRefreshing,
					hasNewData: inputs.hasNewDataSince(model.sessionsUpdatedAtMs),
					onRefresh: Message.ClickedRefresh(),
				}),
				timeRangeSelect(h, range, (next) => Message.ChangedRange({ range: next })),
			],
			"shrink-0",
		),
	])
	return pageShell(h, { sidebar: sidebar(h, model, filters, hasActiveFilters), toolbar: bar, activeFilterCount, onOpenFilters: Message.ClickedOpenFilters() }, [content()])
})
export type SessionsViewInputs = PageViewInputs
