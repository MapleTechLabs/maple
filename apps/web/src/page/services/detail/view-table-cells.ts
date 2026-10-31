import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { eyebrowVariants } from "../../../ui/eyebrow"
import { backdropBar } from "../../../ui/meter"
import { ariaSort, sortButton, tableCell, tableHead } from "../../../ui/table"
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
		title?: string
	}>,
): Html => {
	const isRight = (options.align ?? "right") === "right"
	const isActive = options.sort.key === options.sortKey
	return headLabel(
		h,
		[
			sortButton(
				h,
				{
					isActive,
					direction: options.sort.dir,
					onClick: Message.ClickedSort({ table: options.table, key: options.sortKey }),
					align: isRight ? "right" : "left",
					// The whole head cell stays clickable; row-reverse puts `justify-start` on the right.
					className: cn(isRight && "w-full justify-start"),
				},
				[options.label],
			),
		],
		cn(isRight && "text-right", options.className),
		[
			...ariaSort(h, isActive, options.sort.dir),
			...(options.title === undefined ? [] : [h.Title(options.title)]),
		],
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
