import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { eyebrowVariants } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { backdropBar } from "../../../ui/meter"
import { tableCell, tableHead } from "../../../ui/table"
import { Message } from "./message"
import type { SortState } from "../../kit/table-sort"
import type { SortTable } from "./model-tabs"

// The shared cells of the tab tables.

type H = HtmlBuilder<Message>

/** `HeadLabel`: a non-sortable column header styled as an eyebrow. */
export const headLabel = (
	h: H,
	children: ReadonlyArray<Html | string>,
	className?: string,
	attributes: ReadonlyArray<Attribute<Message>> = [],
): Html => tableHead(h, children, cn(eyebrowVariants(), "h-8", className), attributes)

/** `SortableHeader`: the label and the up-down arrow, rotated for ascending. */
const sortableHeader = (
	h: H,
	table: SortTable,
	sortKey: string,
	label: string,
	sort: SortState,
	className?: string,
) => {
	const isActive = sort.key === sortKey
	return h.button(
		[
			h.Type("button"),
			h.OnClick(Message.ClickedSort({ table, key: sortKey })),
			h.Class(
				cn(
					"inline-flex items-center gap-1 transition-colors",
					isActive ? "text-foreground" : "hover:text-foreground",
					className,
				),
			),
		],
		[
			label,
			icon(h, "ArrowUpDownIcon", {
				size: 10,
				className: cn(
					"shrink-0 transition-opacity",
					isActive ? "opacity-100" : "opacity-40",
					isActive && sort.dir === "asc" && "rotate-180",
				),
			}),
		],
	)
}

/** `SortColumnHead`: right-aligned by default, `aria-sort` on the active column. */
export const sortColumnHead = (
	h: H,
	options: Readonly<{
		table: SortTable
		sortKey: string
		label: string
		sort: SortState
		align?: "left" | "right"
		className?: string
	}>,
): Html => {
	const isRight = (options.align ?? "right") === "right"
	const isActive = options.sort.key === options.sortKey
	return headLabel(
		h,
		[
			sortableHeader(
				h,
				options.table,
				options.sortKey,
				options.label,
				options.sort,
				cn(isRight && "w-full justify-end"),
			),
		],
		cn(isRight && "text-right", options.className),
		isActive ? [h.Attribute("aria-sort", options.sort.dir === "asc" ? "ascending" : "descending")] : [],
	)
}

const BAR_TONE = {
	calls: "bg-severity-info/20",
	errors: "bg-severity-error/25",
	latency: "bg-severity-warn/20",
} as const

/** `BarCell`: a numeric cell over a column-tinted distribution bar. */
export const barCell = (
	h: H,
	options: Readonly<{ value: number; max: number; tone: keyof typeof BAR_TONE }>,
	child: Html,
): Html =>
	tableCell(
		h,
		[
			backdropBar(h, {
				value: options.value,
				max: options.max,
				align: "right",
				className: cn(
					"opacity-50 transition-opacity group-hover/row:opacity-90",
					BAR_TONE[options.tone],
				),
			}),
			h.span([h.Class("relative pr-1.5")], [child]),
		],
		"relative py-2 text-right align-middle tabular-nums",
	)
