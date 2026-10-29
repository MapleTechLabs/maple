import { peekPosition } from "./peek"
import { MountPeekRows } from "./command"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { tableBodyStyles } from "@maple/ui/styles/ui/table"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { excludedEmptyHint } from "../../../ui/filters/excluded-empty-hint"
import { listFooter, loadingMoreRow } from "../../../ui/list-footer"
import { table, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { tableSkeleton } from "../../../ui/table-skeleton"
import { signalEmptyState } from "../../kit/signal-empty-state"
import { presenceOf } from "../../kit/signal-presence"
import { canWidenTimeRange, isFiltered, traceFilterChips } from "./derive"
import { Message, type SortKey } from "./message"
import type { Model } from "./model"
import { allRows, DEFAULT_PRESET, hasNextPage, hiddenCount, MAX_RETAINED_TRACES } from "./update"
import { noiseNote, timeFormat, traceRow } from "./view-row"
import { COUNT_ATTRIBUTE, VirtualizeTraces } from "./virtualize"

/** `TRACE_COLUMNS`: shared by the table, the skeleton and the header. */
const COLUMNS = [
	{ id: "traceId", header: "Trace ID", width: 100, skeleton: "w-16" },
	{ id: "rootSpan", header: "Root span", skeleton: "w-40" },
	{
		id: "services",
		header: "Services",
		width: 160,
		skeleton: "w-24",
		responsive: "hidden @min-[680px]/page:table-cell",
	},
	{
		id: "spanCount",
		header: "Spans",
		width: 70,
		skeleton: "w-8",
		responsive: "hidden @min-[560px]/page:table-cell",
	},
	{
		id: "durationMs",
		header: "Duration",
		width: 100,
		skeleton: "w-16",
		responsive: "hidden @min-[480px]/page:table-cell",
	},
	{ id: "status", header: "Status", width: 80, skeleton: "w-12" },
] as const satisfies ReadonlyArray<{
	id: string
	header: string
	skeleton: string
	width?: number
	responsive?: string
}>

const responsiveOf = (column: (typeof COLUMNS)[number]): string | undefined =>
	"responsive" in column ? column.responsive : undefined
const widthOf = (column: (typeof COLUMNS)[number]): number | undefined =>
	"width" in column ? column.width : undefined

const loadingState = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex-1 min-h-0 flex flex-col gap-4")],
		[
			tableSkeleton(h, {
				rows: 10,
				rowClassName: "h-11",
				tableClassName: "w-full table-fixed",
				columns: COLUMNS.map((column) => ({
					header: column.header,
					headClassName: responsiveOf(column),
					cellClassName: responsiveOf(column),
					skeleton: column.skeleton,
					width: widthOf(column),
				})),
			}),
		],
	)

/** A sortable column header, no hint. */
const sortableHeader = (h: HtmlBuilder<Message>, label: string, sortKey: SortKey, model: Model): Html => {
	const isActive = (model.search.sortBy ?? "timestamp") === sortKey
	const isAscending = (model.search.sortDir ?? "desc") === "asc"
	return h.button(
		[
			h.Class(
				cn(
					"inline-flex items-center gap-1 transition-colors",
					isActive ? "text-foreground" : "hover:text-foreground",
				),
			),
			h.Type("button"),
			h.OnClick(Message.ClickedSort({ key: sortKey })),
		],
		[
			label,
			icon(h, "ArrowUpDownIcon", {
				size: 10,
				className: cn(
					"shrink-0 transition-opacity",
					isActive ? "opacity-100" : "opacity-40",
					isActive && isAscending && "rotate-180",
				),
			}),
		],
	)
}

const header = (h: HtmlBuilder<Message>, model: Model): Html => {
	const sortBy = model.search.sortBy ?? "timestamp"
	const sortDir = model.search.sortDir ?? "desc"
	return tableHeader(
		h,
		[
			tableRow(
				h,
				COLUMNS.map((column) => {
					const width = widthOf(column)
					return tableHead(
						h,
						[
							column.id === "durationMs"
								? sortableHeader(h, column.header, "durationMs", model)
								: column.header,
						],
						cn("px-2", responsiveOf(column)),
						[
							...(column.id === sortBy
								? [h.AriaSort(sortDir === "asc" ? "ascending" : "descending")]
								: []),
							...(width === undefined ? [] : [h.Style({ width: `${width}px` })]),
						],
					)
				}),
			),
		],
		{ sticky: true, className: "z-20" },
	)
}

const spacer = (h: HtmlBuilder<Message>, key: string, height: number): Html =>
	h.tr([h.Key(key), h.AriaHidden(true), h.Style({ height: `${height}px` })], [h.td([], [])])

/** `VirtualTableBody`: spacers around the rendered window, then the loading row. */
const body = (h: HtmlBuilder<Message>, model: Model, timeZone: string, isMobile: boolean): Html => {
	const rows = allRows(model)
	const time = timeFormat(timeZone)
	const activeIndex = isMobile ? null : (peekPosition(model)?.index ?? null)
	const first = model.virtualRows[0]
	const last = model.virtualRows.at(-1)
	return h.tbody(
		[h.Class(tableBodyStyles), h.DataAttribute("slot", "table-body")],
		[
			...(first === undefined ? [] : [spacer(h, "spacer-before", first.start)]),
			...model.virtualRows.flatMap((item) => {
				const row = rows[item.index]
				return row === undefined
					? []
					: [
							traceRow(h, row, item.index, time, model.nowMs, {
								search: model.search,
								isFocused: model.focusedIndex === item.index,
								isActive: activeIndex === item.index,
								isMobile,
							}),
						]
			}),
			...(last === undefined ? [] : [spacer(h, "spacer-after", model.totalSize - last.end)]),
			...(model.pagination.isFetching
				? [
						h.tr(
							[h.Key("loading-more")],
							[
								h.td(
									[h.Attribute("colspan", String(COLUMNS.length)), h.Class("p-2")],
									[loadingMoreRow(h, "Loading more traces…")],
								),
							],
						),
					]
				: []),
		],
	)
}

const loadedTable = (
	h: HtmlBuilder<Message>,
	model: Model,
	timeZone: string,
	isWaiting: boolean,
	isMobile: boolean,
): Html => {
	const count = allRows(model).length
	const hidden = hiddenCount(model)
	return h.div(
		[
			h.Class(cn("flex min-h-0 flex-1 flex-col gap-4", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
			h.OnMount(MountPeekRows()),
		],
		[
			h.div(
				[
					h.Class("flex-1 min-h-0 overflow-auto rounded-md border"),
					h.DataAttribute(COUNT_ATTRIBUTE, String(count)),
					h.OnMount(VirtualizeTraces()),
				],
				[
					table(h, { scroll: false, className: "table-fixed", ariaLabel: "Traces" }, [
						header(h, model),
						body(h, model, timeZone, isMobile),
					]),
				],
			),
			h.div(
				[h.Class("flex shrink-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground")],
				[
					listFooter(h, {
						shown: count,
						noun: "traces",
						isCapped: count >= MAX_RETAINED_TRACES,
						hasMore: hasNextPage(model),
						align: "start",
						className: "p-0",
					}),
					hidden > 0 ? noiseNote(h, hidden) : null,
				],
			),
		],
	)
}

const emptyTable = (h: HtmlBuilder<Message>, model: Model): Html => {
	const excluded = traceFilterChips(model.search)
		.filter((chip) => chip.negated)
		.flatMap((chip) => chip.values)
	return h.div(
		[h.Class("flex-1 min-h-0 flex flex-col gap-4")],
		[
			h.div(
				[h.Class("rounded-md border")],
				[
					signalEmptyState(h, {
						signal: "traces",
						presence: presenceOf(model.presence, "traces"),
						nowMs: model.nowMs,
						isFiltered: isFiltered(model.search),
						onClearFilters: Message.ClickedClearFilters(),
						onWidenRange: canWidenTimeRange(model.search, DEFAULT_PRESET)
							? Message.ClickedWidenRange()
							: undefined,
						detail: excludedEmptyHint(h, {
							excluded,
							onClear: Message.ClickedClearExclusions(),
							className: "mx-auto max-w-lg",
						}),
					}),
				],
			),
		],
	)
}

export const tracesTable = (
	h: HtmlBuilder<Message>,
	model: Model,
	timeZone: string,
	isMobile = false,
): Html =>
	AsyncData.matchData(model.firstPage.data, {
		// A workspace that never sent traces gets its setup state without waiting on the list.
		onEmpty: () =>
			presenceOf(model.presence, "traces").status === "absent" && !isFiltered(model.search)
				? emptyTable(h, model)
				: loadingState(h),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load traces", onRetry: Message.ClickedReload() }),
		onData: () =>
			allRows(model).length === 0
				? emptyTable(h, model)
				: loadedTable(h, model, timeZone, AsyncData.isRefreshing(model.firstPage.data), isMobile),
	})
