import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { tableHeadLabelStyles } from "@maple/ui/styles/ui/table"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import { sortButton } from "../../../ui/table"
import type { SortDir } from "../../kit/table-sort"

// `DataTable`, `ColumnHead` and `ROW_LINK_CLASS`.

export const ROW_LINK_CLASS =
	"group flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0 hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"

/** A sortable head's state: `null` sort is the skeleton's inert head (no current key). */
export const headSort = <M, K extends string>(
	sort: Readonly<{ key: string | null; dir: SortDir }> | null,
	key: K,
	onSort: (key: K) => M,
) =>
	sort === null
		? { isActive: false, dir: "desc" as const }
		: { isActive: sort.key === key, dir: sort.dir, onSort: onSort(key) }

export type ColumnHeadOptions<M> = Readonly<{
	label: string
	width: string
	/** Present on sortable heads: the head is a button (inert in a skeleton, `onSort` absent). */
	sort?: Readonly<{ isActive: boolean; dir: SortDir; onSort?: M }>
	align?: "left" | "right"
	hidden?: string
}>

/** A column head in the kit's table-head type; a sortable one is the kit `sortButton`. */
export const columnHead = <M>(h: HtmlBuilder<M>, options: ColumnHeadOptions<M>): Html => {
	const sort = options.sort
	return h.div(
		[
			h.Class(
				cn(
					"flex items-center",
					tableHeadLabelStyles,
					options.align === "right" && "justify-end",
					options.width,
					options.hidden,
				),
			),
		],
		[
			sort?.onSort === undefined
				? h.span([], [options.label])
				: sortButton(
						h,
						{
							isActive: sort.isActive,
							direction: sort.dir,
							onClick: sort.onSort,
							align: options.align,
						},
						[options.label],
					),
		],
	)
}

export type DataTableOptions = Readonly<{
	ariaLabel: string
	isWaiting?: boolean
	/** Caps the row area and pins the head (`maxHeight`). */
	maxHeight?: string
	stickySurfaceClass?: string
	className?: string
}>

/** `DataTable.Root` + `DataTable.Head`: the head row, then rows (or `dataTableEmpty`). */
export const dataTable = <M>(
	h: HtmlBuilder<M>,
	options: DataTableOptions,
	head: ReadonlyArray<Html>,
	rows: ReadonlyArray<Html>,
): Html => {
	const isWaiting = options.isWaiting === true
	const scrolls = options.maxHeight !== undefined
	const headClass = cn(
		"flex items-center gap-4 border-b border-border-subtle px-4 py-2",
		scrolls && `sticky top-0 z-10 ${options.stickySurfaceClass ?? "bg-background"}`,
	)
	return h.div(
		[
			h.Class(cn("border-y border-border-subtle", refreshingClass(isWaiting), options.className)),
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
				[h.div([h.Class("min-w-fit")], [h.div([h.Class(headClass)], head), ...rows])],
			),
		],
	)
}

/** `DataTable.Empty`. */
export const dataTableEmpty = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	emptyMessage(h, { className: "py-12" }, children)

/** `DataTable.SkeletonRows`: `count` identical placeholder rows. */
export const skeletonRows = <M>(
	h: HtmlBuilder<M>,
	count: number,
	cells: () => ReadonlyArray<Html>,
): ReadonlyArray<Html> =>
	Array.from({ length: count }, () =>
		h.div(
			[h.Class("flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0")],
			cells(),
		),
	)
