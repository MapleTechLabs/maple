import { cn } from "@maple/ui/lib/utils"
import { badge } from "@maple/web/ui/display"
import { button } from "@maple/web/ui/button"
import { serviceDot } from "@maple/web/ui/values"
import type { Html } from "foldkit/html"
import type { TracesViewBuilder } from "./composition"
import { refreshButton, timeRangeSelect, toolbar, toolbarSearch, toolbarStat, toolbarStats } from "../kit/toolbar"
import type { TraceFilters } from "./filters"
import { Message } from "./message"
import type { Model } from "./model"

// The toolbar of `TraceListView` and its `SpanScopeBanner`.

const spanScopeBanner = (h: TracesViewBuilder, filters: TraceFilters): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm")],
		[
			h.span([h.Class("text-muted-foreground")], ["Traces containing a span"]),
			...(filters.service
				? [
						h.span([h.Class("text-muted-foreground")], ["from"]),
						badge(h, { variant: "outline", className: "font-mono text-xs" }, [
							serviceDot(h, { serviceName: filters.service, size: "sm" }),
							filters.service,
						]),
					]
				: []),
			...(filters.span
				? [
						h.span([h.Class("text-muted-foreground")], ["named"]),
						badge(h, { variant: "outline", className: "max-w-64 truncate font-mono text-xs", attributes: [h.Title(filters.span)] }, [
							filters.span,
						]),
					]
				: []),
			button(h, { variant: "ghost", size: "xs", attributes: [h.OnClick(Message.ClickedExitSpanScope())] }, ["Root spans only"]),
		],
	)

export const tracesToolbar = (
	h: TracesViewBuilder,
	model: Model,
	filters: TraceFilters,
	options: Readonly<{ rowCount: number; hasNextPage: boolean; range: string; hasNewData: boolean }>,
): Html => {
	const spanScope = filters.scope === "spans"
	return toolbar(h, [
		spanScope ? spanScopeBanner(h, filters) : null,
		spanScope && filters.span
			? null
			: toolbarSearch(h, {
					id: "traces-search",
					value: model.search.text,
					placeholder: spanScope ? "Filter by any span name…" : "Filter by span name…",
					onInput: (text) => Message.ChangedSearch({ text }),
					onClear: Message.ClickedClearSearch(),
					className: "min-w-48 flex-1",
				}),
		toolbarStats(
			h,
			[
				toolbarStat(h, { value: options.rowCount, label: options.hasNextPage ? "traces+" : "traces" }),
				refreshButton(h, { isSpinning: model.isRefreshing, hasNewData: options.hasNewData, onRefresh: Message.ClickedRefresh() }),
				timeRangeSelect(h, options.range, (range) => Message.ChangedRange({ range })),
			],
			cn("shrink-0"),
		),
	])
}
