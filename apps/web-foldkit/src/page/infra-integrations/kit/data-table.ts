import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"

// `DataTable`, `ColumnHead` and `ROW_LINK_CLASS` (apps/web/src/components/common/data-table.tsx):
// the flex-row list table whose rows are links.

export const ROW_LINK_CLASS =
	"group flex items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"

export type SortDir = "asc" | "desc"

export type ColumnHeadOptions<M> = Readonly<{
	label: string
	width: string
	/**
	 * Sortable when set: whether this column is the active sort, and the click Message (none in a
	 * skeleton, whose heads are inert buttons).
	 */
	sort?: Readonly<{ onSort?: M; isActive: boolean; dir: SortDir }>
	align?: "left" | "right"
	hidden?: string
}>

export const columnHead = <M>(h: HtmlBuilder<M>, options: ColumnHeadOptions<M>): Html => {
	const sort = options.sort
	return h.div(
		[
			h.Class(
				cn(
					"flex items-center text-2xs font-medium",
					options.align === "right" && "justify-end",
					options.width,
					options.hidden,
				),
			),
		],
		[
			sort === undefined
				? h.span([h.Class("text-muted-foreground")], [options.label])
				: h.button(
						[
							h.Type("button"),
							...(sort.onSort === undefined ? [] : [h.OnClick(sort.onSort)]),
							h.Class(
								cn(
									"inline-flex items-center gap-1 transition-colors",
									sort.isActive
										? "text-foreground"
										: "text-muted-foreground hover:text-foreground",
								),
							),
						],
						[
							options.label,
							icon(h, "ArrowUpDownIcon", {
								size: 10,
								className: cn(
									"transition-opacity",
									sort.isActive ? "opacity-100" : "opacity-40",
									sort.isActive && sort.dir === "asc" && "rotate-180",
								),
							}),
						],
					),
		],
	)
}

export type DataTableOptions = Readonly<{
	ariaLabel: string
	isWaiting?: boolean
	/** `maxHeight`: the row area scrolls inside this height with the heads pinned. */
	maxHeight?: string
	stickySurfaceClass?: string
	className?: string
}>

/** `DataTable.Root`; `head` is the `DataTable.Head` children, `rows` the rows. */
export const dataTable = <M>(
	h: HtmlBuilder<M>,
	options: DataTableOptions,
	head: ReadonlyArray<Html>,
	rows: ReadonlyArray<Html>,
): Html => {
	const scrolls = options.maxHeight !== undefined
	const isWaiting = options.isWaiting === true
	return h.div(
		[
			h.Class(cn("border-y border-border/70", refreshingClass(isWaiting), options.className)),
			h.AriaLabel(options.ariaLabel),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			h.div(
				[
					h.Class(cn("overflow-x-auto", scrolls && "overflow-y-auto overscroll-contain")),
					...(options.maxHeight === undefined
						? []
						: [h.Style({ "max-height": options.maxHeight })]),
				],
				[
					h.div(
						[h.Class("min-w-fit")],
						[
							h.div(
								[
									h.Class(
										cn(
											"flex items-center gap-4 border-b border-border/60 px-4 py-2",
											scrolls &&
												`sticky top-0 z-10 ${options.stickySurfaceClass ?? "bg-background"}`,
										),
									),
								],
								head,
							),
							...rows,
						],
					),
				],
			),
		],
	)
}

/** `DataTable.Empty`. */
export const dataTableEmpty = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	emptyMessage(h, { className: "py-12" }, children)

/** `DataTable.SkeletonRows`: `count` copies of one row's cells. */
export const dataTableSkeletonRows = <M>(
	h: HtmlBuilder<M>,
	count: number,
	cells: () => ReadonlyArray<Html>,
): ReadonlyArray<Html> =>
	Array.from({ length: count }, () =>
		h.div(
			[h.Class("flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0")],
			cells(),
		),
	)
