import type { AiSessionSortKey } from "@maple/domain/http"
import { formatCost, sessionLinkWindow, sessionRowIdParts } from "@maple/agent-sessions"
import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { formatCount } from "../../../ui/filters/range-format"
import { icon, type IconName } from "../../../ui/icon"
import { loadingMoreRow } from "../../../ui/list-footer"
import { statusDot } from "../../../ui/status-dot"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { tableSkeleton } from "../../../ui/table-skeleton"
import { servicePills } from "../../../ui/trace-badges"
import type { DetectedModel } from "../kit/detected-models"
import { modelLabel } from "../kit/model-label"
import { type VirtualWindow, virtualAttributes } from "../kit/virtualize"
import { sessionHeading } from "../kit/session-name"
import { vendorColor, vendorIcon, vendorLabel } from "../kit/vendor"
import type { DisplayRow, Sort } from "./derive"
import { Message } from "./message"

// The agent sessions list, windowed.
// TODO(tooltip): every `Hint` is drawn as its trigger; the popups are not ported.

type H = HtmlBuilder<Message>

/** The virtualizer's estimate before a row is measured. */
const ROW_HEIGHT = 53

interface Column {
	readonly id: string
	readonly header: string
	readonly skeleton: string
	readonly width?: number
	readonly responsive?: string
	readonly sort?: Readonly<{ key: AiSessionSortKey; hint?: boolean }>
}

const COLUMNS: ReadonlyArray<Column> = [
	{ id: "session", header: "Session", skeleton: "w-40" },
	{
		id: "services",
		header: "Services",
		width: 170,
		skeleton: "w-24",
		responsive: "hidden @min-[1110px]/page:table-cell",
	},
	{
		id: "model",
		header: "Model",
		width: 160,
		skeleton: "w-24",
		responsive: "hidden @min-[1270px]/page:table-cell",
	},
	{
		id: "durationMs",
		header: "Duration",
		width: 100,
		skeleton: "w-12",
		responsive: "hidden @min-[500px]/page:table-cell",
		sort: { key: "durationMs", hint: true },
	},
	{
		id: "llmCalls",
		header: "LLM calls",
		width: 110,
		skeleton: "w-8",
		responsive: "hidden @min-[690px]/page:table-cell",
		sort: { key: "llmCalls", hint: true },
	},
	{
		id: "toolCalls",
		header: "Tool calls",
		width: 116,
		skeleton: "w-8",
		responsive: "hidden @min-[810px]/page:table-cell",
		sort: { key: "toolCalls", hint: true },
	},
	{
		id: "totalTokens",
		header: "Tokens",
		width: 130,
		skeleton: "w-20",
		responsive: "hidden @min-[940px]/page:table-cell",
		sort: { key: "totalTokens", hint: true },
	},
	{
		id: "cost",
		header: "Cost",
		width: 80,
		skeleton: "w-10",
		responsive: "hidden @min-[580px]/page:table-cell",
		sort: { key: "cost", hint: true },
	},
	{
		id: "errorSpanCount",
		header: "Errors",
		width: 100,
		skeleton: "w-12",
		sort: { key: "errorSpanCount", hint: true },
	},
	{
		id: "startTime",
		header: "Started",
		width: 96,
		skeleton: "w-14",
		responsive: "hidden @min-[400px]/page:table-cell",
		sort: { key: "startTime" },
	},
]

export const listSkeleton = (h: H): Html =>
	tableSkeleton(h, {
		rows: 10,
		tableClassName: "w-full table-fixed",
		columns: COLUMNS.map((column) => ({
			header: column.header,
			headClassName: column.responsive,
			cellClassName: column.responsive,
			skeleton: column.skeleton,
			width: column.width,
		})),
	})

// A row link stretched over its row, and the lift for tooltips above it.
const ROW_STRETCHED_LINK_CLASS =
	"after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-ring focus-visible:after:ring-inset"
const ROW_LIFT_TOOLTIPS = "[&_[data-slot=tooltip-trigger]]:relative [&_[data-slot=tooltip-trigger]]:z-10"

const triggerAttributes = (h: H): ReadonlyArray<Attribute<Message>> => [
	h.DataAttribute("base-ui-tooltip-trigger", ""),
	h.DataAttribute("slot", "tooltip-trigger"),
]

/** `Hint`: an inline figure whose tooltip says what it counts. A lifted trigger: a plain click on it
 *  reaches the row's click handler (`MountRowClicks`), which opens the session. */
const hint = (h: H, className: string, children: ReadonlyArray<Html | string>): Html =>
	h.span([h.Class(className), ...triggerAttributes(h)], children)

/** `SortableHeader`; a column with a hint renders its button as a tooltip trigger. */
const sortableHeader = (h: H, column: Column, sort: Sort): Html => {
	const key = column.sort?.key ?? "startTime"
	const isActive = sort.sortBy === key
	return h.button(
		[
			h.Class(
				cn(
					"inline-flex items-center gap-1 transition-colors",
					isActive ? "text-foreground" : "hover:text-foreground",
				),
			),
			...(column.sort?.hint === true ? triggerAttributes(h) : []),
			h.Type("button"),
			h.OnClick(Message.ClickedSort({ key })),
		],
		[
			column.header,
			icon(h, "ArrowUpDownIcon", {
				size: 10,
				className: cn(
					"shrink-0 transition-opacity",
					isActive ? "opacity-100" : "opacity-40",
					isActive && sort.sortDir === "asc" && "rotate-180",
				),
			}),
		],
	)
}

const header = (h: H, sort: Sort): Html =>
	tableHeader(
		h,
		[
			tableRow(
				h,
				COLUMNS.map((column) =>
					tableHead(
						h,
						column.sort === undefined ? [column.header] : [sortableHeader(h, column, sort)],
						cn("px-2", column.responsive),
						[
							...(column.sort?.key === sort.sortBy
								? [
										h.Attribute(
											"aria-sort",
											sort.sortDir === "asc" ? "ascending" : "descending",
										),
									]
								: []),
							...(column.width === undefined ? [] : [h.Style({ width: `${column.width}px` })]),
						],
					),
				),
			),
		],
		{ sticky: true },
	)

export type RowContext = Readonly<{
	nowMs: number
	timeZone: string
	detect: (model: string) => DetectedModel
}>

export const sessionHref = (row: DisplayRow): string =>
	hrefOf(AppRoute.AgentSession({ sessionId: row.sessionId, search: sessionLinkWindow(row) }))

const startedAt = (h: H, row: DisplayRow, context: RowContext, className: string): Html =>
	hint(h, className, [formatRelativeTimeOrDate(row.startTime, context.nowMs, context.timeZone)])

/** The agent it ran beside the framework's mark, over the id it is cited by. */
const sessionCell = (h: H, row: DisplayRow, context: RowContext): Html => {
	const vendor = vendorLabel(row.vendorId)
	const id = sessionRowIdParts(row.sessionId)
	const href = sessionHref(row)
	return h.div(
		[h.Class("min-w-0")],
		[
			h.a([h.AriaHidden(true), h.Class(ROW_STRETCHED_LINK_CLASS), h.Href(href), h.Tabindex(-1)], []),
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					h.span(
						[
							h.AriaLabel(vendor),
							h.Class("flex shrink-0 items-center"),
							...triggerAttributes(h),
							h.Role("img"),
						],
						[
							icon(h, vendorIcon(row.vendorId), {
								size: 15,
								style: { color: vendorColor(row.vendorId) },
								attributes: [h.AriaHidden(true)],
							}),
						],
					),
					h.a(
						[
							h.Class(
								"min-w-0 truncate text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none",
							),
							...triggerAttributes(h),
							h.Href(href),
						],
						[sessionHeading(row.firstAgentName, row.vendorId)],
					),
					startedAt(
						h,
						row,
						context,
						"ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @min-[400px]/page:hidden",
					),
				],
			),
			h.div(
				[h.Class("mt-0.5 flex min-w-0 items-baseline gap-1.5 text-xs"), ...triggerAttributes(h)],
				[
					h.span(
						[h.Class("shrink-0 text-muted-foreground/70")],
						[id.kind === "trace" ? "Trace" : "Session"],
					),
					h.span([h.Class("min-w-0 truncate font-mono text-muted-foreground")], [id.short]),
				],
			),
		],
	)
}

const modelCell = (h: H, row: DisplayRow, context: RowContext): Html | null => {
	const [firstModel] = row.models
	return firstModel === undefined
		? null
		: hint(h, "block min-w-0 text-xs text-muted-foreground", [
				modelLabel(h, {
					detected: context.detect(firstModel),
					moreCount: row.models.length - 1,
					title: null,
				}),
			])
}

/** A count with the kind's glyph, in its hue. */
const workCount = (h: H, iconName: IconName, tone: string, count: number): Html =>
	hint(
		h,
		cn("inline-flex items-center gap-1 text-xs tabular-nums", count > 0 ? tone : "text-muted-foreground"),
		[
			icon(h, iconName, { size: 12, className: "shrink-0", attributes: [h.AriaHidden(true)] }),
			formatCount(count),
		],
	)

const BUCKET_COVERAGE_MIN = 0.9

/** In over out, each in its side's colour; a session that reported only a total shows the total. */
const tokenBar = (h: H, row: DisplayRow): Html | null => {
	const inputs = [row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens].filter((value) => value > 0)
	const outputs = [row.outputTokens, row.reasoningTokens].filter((value) => value > 0)
	const drawnTotal = [...inputs, ...outputs].reduce((sum, value) => sum + value, 0)
	const hasBuckets = drawnTotal > 0 && drawnTotal >= row.totalTokens * BUCKET_COVERAGE_MIN
	const total = hasBuckets ? drawnTotal : row.totalTokens
	if (total === 0) return null
	if (!hasBuckets) {
		return hint(h, "font-mono text-xs tabular-nums text-muted-foreground", [formatCount(total)])
	}
	const sides = [
		{ label: "in", tone: "text-chart-tok-input", count: inputs.reduce((sum, value) => sum + value, 0) },
		{
			label: "out",
			tone: "text-chart-tok-reasoning",
			count: outputs.reduce((sum, value) => sum + value, 0),
		},
	]
	return hint(
		h,
		"flex flex-col gap-0.5 font-mono text-xs tabular-nums",
		sides.map((side) =>
			h.span(
				[h.Class("flex items-baseline gap-1.5")],
				[
					h.span(
						[
							h.Class(
								cn(
									"min-w-12 text-right",
									side.count > 0 ? side.tone : "text-muted-foreground/50",
								),
							),
						],
						[side.count > 0 ? formatCount(side.count) : EMPTY_VALUE],
					),
					h.span([h.Class("text-muted-foreground")], [side.label]),
				],
			),
		),
	)
}

const errorChip = (
	h: H,
	options: Readonly<{ iconName?: IconName; count: number; noun: string; className: string }>,
): Html =>
	hint(h, cn(badgeVariants({ pill: true, size: "xs", mono: true }), options.className), [
		options.iconName === undefined
			? statusDot(h, { tone: "custom", size: "sm", className: "bg-current" })
			: icon(h, options.iconName, {
					size: 10,
					className: "shrink-0",
					attributes: [h.AriaHidden(true)],
				}),
		h.span(
			[],
			[
				h.span([h.Class("inline-block min-w-[2ch] text-right")], [String(options.count)]),
				" ",
				h.span(
					[h.Class("inline-block min-w-[5ch]")],
					[options.count === 1 ? options.noun : `${options.noun}s`],
				),
			],
		),
	])

const TURN_CHIP = "border-severity-error/30 bg-severity-error/10 text-severity-error"
const TOOL_CHIP = "border-severity-warn/40 bg-severity-warn/10 text-severity-warn"

/** Tool failures apart from turn failures; an unclassified failure only when it is all there is. */
const errorChips = (h: H, row: DisplayRow): Html => {
	if (row.errorSpanCount === 0) return h.span([h.Class("text-xs text-muted-foreground/50")], [EMPTY_VALUE])
	const classified = row.toolErrorCount + row.turnErrorCount
	const other = row.errorSpanCount - classified
	return h.div(
		[h.Class("flex flex-col items-start gap-1")],
		[
			...(row.turnErrorCount > 0
				? [
						errorChip(h, {
							iconName: "FaceRobotIcon",
							count: row.turnErrorCount,
							noun: "turn",
							className: TURN_CHIP,
						}),
					]
				: []),
			...(row.toolErrorCount > 0
				? [
						errorChip(h, {
							iconName: "GearIcon",
							count: row.toolErrorCount,
							noun: "tool",
							className: TOOL_CHIP,
						}),
					]
				: []),
			...(classified === 0 && other > 0
				? [errorChip(h, { count: other, noun: "span", className: TURN_CHIP })]
				: []),
		],
	)
}

const CELL_CLASS = "p-2 whitespace-normal leading-normal"

const cellsOf = (h: H, row: DisplayRow, context: RowContext): ReadonlyArray<Html | null> => [
	sessionCell(h, row, context),
	row.serviceNames.length === 0 ? null : servicePills(h, row.serviceNames),
	modelCell(h, row, context),
	hint(h, "font-mono text-xs tabular-nums", [formatSessionDuration(row.durationMs)]),
	workCount(h, "PixelSparkleIcon", "text-chart-ai-inference", row.llmCalls),
	workCount(h, "GearIcon", "text-chart-ai-tool", row.toolCalls),
	tokenBar(h, row),
	row.cost > 0 ? hint(h, "font-mono text-xs tabular-nums", [formatCost(row.cost)]) : null,
	errorChips(h, row),
	startedAt(h, row, context, "block truncate text-xs text-muted-foreground"),
]

const sessionRow = (h: H, row: DisplayRow, index: number, context: RowContext): Html => {
	return tableRow(
		h,
		cellsOf(h, row, context).map((cell, column) =>
			tableCell(h, cell === null ? [] : [cell], cn(CELL_CLASS, COLUMNS[column]?.responsive)),
		),
		cn("cursor-pointer hover:bg-muted/50", ROW_LIFT_TOOLTIPS),
		[
			h.Key(row.sessionId),
			h.DataAttribute("index", String(index)),
			h.DataAttribute("session-href", sessionHref(row)),
		],
	)
}

/** `VirtualTableBody`'s spacers: the table keeps its full height around the rendered window. */
const spacer = (h: H, key: string, height: number): Html =>
	h.tr([h.Key(key), h.AriaHidden(true), h.Style({ height: `${height}px` })], [h.td([], [])])

/** The rows the virtualizer mounted, between their spacers; every row without a virtualizer. */
const windowRows = (
	h: H,
	rows: ReadonlyArray<DisplayRow>,
	context: RowContext,
	window: VirtualWindow | undefined,
): ReadonlyArray<Html> => {
	if (window === undefined)
		return [
			spacer(h, "top", 0),
			...rows.map((row, index) => sessionRow(h, row, index, context)),
			spacer(h, "bottom", 0),
		]
	const { items, scrollMargin, totalSize } = window
	const first = items[0]
	const last = items.at(-1)
	if (first === undefined || last === undefined) return []
	return [
		spacer(h, "top", first.start - scrollMargin),
		...items.flatMap((item) => {
			const row = rows[item.index]
			return row === undefined ? [] : [sessionRow(h, row, item.index, context)]
		}),
		spacer(h, "bottom", totalSize - (last.end - scrollMargin)),
	]
}

export const sessionsTable = (
	h: H,
	options: Readonly<{
		rows: ReadonlyArray<DisplayRow>
		sort: Sort
		context: RowContext
		hasMore: boolean
		isLoadingMore: boolean
		isCapped: boolean
		/** The table's paint and list-end Mounts; a lab without a server leaves them off. */
		onPainted?: Attribute<Message>
		onReachEnd?: Attribute<Message>
		/** The rows' click handler (`MountRowClicks`); a lab without a router leaves it off. */
		onRowClick?: Attribute<Message>
		/** The virtualizer's window and its Mount; without one every row is drawn. */
		virtual?: Readonly<{ window: VirtualWindow; mount: Attribute<Message> }>
	}>,
): Html =>
	h.div(options.onPainted === undefined ? [] : [options.onPainted], [
		h.div(
			[h.Class("rounded-md border"), ...(options.onRowClick === undefined ? [] : [options.onRowClick])],
			[
				table(h, { scroll: false, className: "table-fixed", ariaLabel: "Agent sessions" }, [
					header(h, options.sort),
					tableBody(
						h,
						[
							...windowRows(h, options.rows, options.context, options.virtual?.window),
							...(options.isLoadingMore
								? [
										h.tr(
											[h.Key("loading")],
											[
												h.td(
													[
														h.Attribute("colspan", String(COLUMNS.length)),
														h.Class("p-2"),
													],
													[loadingMoreRow(h, "Loading more sessions…")],
												),
											],
										),
									]
								: []),
						],
						undefined,
						options.virtual === undefined
							? []
							: [
									...virtualAttributes(
										h,
										options.rows.map((_, index) => String(index)),
										[ROW_HEIGHT],
									),
									options.virtual.mount,
								],
					),
				]),
			],
		),
		...(options.hasMore
			? [
					h.div(
						[
							h.AriaHidden(true),
							h.Class("h-px w-full"),
							...(options.onReachEnd === undefined ? [] : [options.onReachEnd]),
						],
						[],
					),
				]
			: []),
		...(options.isCapped
			? [
					h.p(
						[h.Class("py-3 text-sm text-muted-foreground")],
						[
							"Showing the ",
							formatNumber(options.rows.length),
							" most recent sessions — filter the list to see older ones",
						],
					),
				]
			: []),
	])
