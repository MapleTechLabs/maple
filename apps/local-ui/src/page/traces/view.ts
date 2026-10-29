import { cn } from "@maple/ui/lib/utils"
import type * as CopyButton from "@maple/web/ui/copy-button"
import { listFooter } from "@maple/web/ui/list-footer"
import { table, tableBody, tableHead, tableHeader, tableRow } from "@maple/web/ui/table"
import { tableSkeleton } from "@maple/web/ui/table-skeleton"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { presenceOf, type PresenceResult } from "../../data/signal-presence"
import { type PageContext, rangeOf } from "../contract"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { errorState } from "../kit/view-states"
import { activeFilterCount, filtersOf } from "./filters"
import { EndpointCopyBinding, EnvCopyBinding, TracesComposition, type TracesViewBuilder } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { traceRow } from "./view-row"
import { sidebar } from "./view-sidebar"
import { tracesToolbar } from "./view-toolbar"

const SKELETON_COLUMNS = [
	{ header: "Trace", headClassName: "w-[40%]", skeleton: "w-56" },
	{ header: "Services", skeleton: "w-40" },
	{ header: "Duration", headClassName: "text-right", skeleton: "ml-auto w-14" },
	{ header: "Spans", headClassName: "text-right", skeleton: "ml-auto w-8" },
	{ header: "Status", skeleton: "w-10" },
	{ header: "Started", headClassName: "text-right", skeleton: "ml-auto w-16" },
]

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type TracesViewInputs = Readonly<{
	context: PageContext
	/** The shared signal presence read (`useSignalPresence`): none while loading or unreadable. */
	maybePresence: Option.Option<PresenceResult>
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the list loaded. */
const hasNewDataSince = (inputs: TracesViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

const GUIDE_ID = "traces-empty"

/** The connect guide's copy buttons are this page's own Blocks. */
const embedGuideCopy =
	(h: TracesViewBuilder, model: Model) =>
	(slot: "endpoint" | "env", viewInputs: CopyButton.CopyButtonViewInputs): Html =>
		slot === "endpoint"
			? h.block(EndpointCopyBinding.embedView({ slotId: `${GUIDE_ID}-endpoint`, model: model.endpointCopy, viewInputs }))
			: h.block(EnvCopyBinding.embedView({ slotId: `${GUIDE_ID}-env`, model: model.envCopy, viewInputs }))

export const view = TracesComposition.makeView.withInputs<TracesViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const query = queryOf(context.location)
	const filters = filtersOf(query)
	const range = rangeOf(context)
	const count = activeFilterCount(query)
	const maybeData = AsyncData.getData(model.traces.data)
	const rows = Option.match(maybeData, { onNone: () => [], onSome: (data) => data.pages.flat() })
	const hasNextPage = Option.exists(maybeData, (data) => data.hasNextPage)
	const content = (): Html => {
		if (isPending(model.traces))
			return tableSkeleton(h, { className: "rounded-none border-0", rows: 12, columns: SKELETON_COLUMNS })
		const failure = failureWithoutData(model.traces)
		if (Option.isSome(failure))
			return errorState(h, { label: "traces", failure: failure.value, onRetry: Message.ClickedRefresh() })
		if (rows.length === 0)
			return signalEmptyState(h, {
				signal: "traces",
				isFiltered: count > 0 || filters.search !== undefined,
				onClearFilters: Message.ClickedClearFilters(),
				range,
				onWidenRange: Message.ClickedWidenRange(),
				maybePresence: presenceOf(inputs.maybePresence, "traces"),
				nowMs: Option.match(inputs.maybePresence, { onNone: () => 0, onSome: (result) => result.nowMs }),
				guide: { id: GUIDE_ID, endpoint: context.env.otlpEndpoint, embedCopy: embedGuideCopy(h, model) },
			})
		return h.div(
			[h.Class(cn(model.traces.isPlaceholder && "opacity-60 transition-opacity"))],
			[
				table(h, {}, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Trace"], "w-[40%]"),
							tableHead(h, ["Services"]),
							tableHead(h, ["Duration"], "text-right"),
							tableHead(h, ["Spans"], "text-right"),
							tableHead(h, ["Status"]),
							tableHead(h, ["Started"], "text-right"),
						]),
					]),
					tableBody(h, rows.map((row) => traceRow(h, row, query, model.nowMs, context.timeFormat))),
				]),
				listFooter(h, { hasMore: hasNextPage, isLoading: model.isFetchingNextPage, onLoadMore: Message.ClickedLoadMore() }),
			].filter((child) => child !== null),
		)
	}
	return pageShell(
		h,
		{
			onOpenFilters: Message.ClickedOpenFilters(),
			sidebar: sidebar(h, model, filters, count),
			toolbar: tracesToolbar(h, model, filters, {
				rowCount: rows.length,
				hasNextPage,
				range,
				hasNewData: hasNewDataSince(inputs, model.tracesUpdatedAtMs),
			}),
			activeFilterCount: count,
		},
		[content()],
	)
})
