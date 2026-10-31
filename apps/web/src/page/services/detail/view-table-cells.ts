import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { eyebrowVariants } from "../../../ui/eyebrow"
import { backdropBar } from "../../../ui/meter"
import { panelHeader } from "../../../ui/panel"
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

// Volume and latency bars stay neutral; only errors carry a colour.
const BAR_TONE = {
	calls: "bg-muted",
	errors: "bg-severity-error-a3",
	latency: "bg-muted",
} as const

/** `BarCell`: a numeric cell over a column-tinted distribution bar. */
export const barCell = (
	h: H,
	options: Readonly<{ value: number; max: number; tone: keyof typeof BAR_TONE; className?: string }>,
	child: Html,
): Html =>
	tableCell(
		h,
		[
			backdropBar(h, {
				value: options.value,
				max: options.max,
				align: "right",
				className: BAR_TONE[options.tone],
			}),
			h.span([h.Class("relative pr-1.5")], [child]),
		],
		cn("relative py-2 text-right align-middle tabular-nums", options.className),
	)

/**
 * The title row every tab table opens with: its name, the row count, and optional controls.
 * Loading skeletons pass no count.
 */
export const tableTitle = (h: H, options: Readonly<{ title: string; count?: number; action?: Html }>): Html =>
	panelHeader(h, {
		title: options.title,
		scope:
			options.count === undefined
				? undefined
				: h.span(
						[h.Class("font-mono text-2xs tabular-nums text-foreground-subtle")],
						[String(options.count)],
					),
		action: options.action,
	})

/** Past 30 days a tab's summaries outlive the raw spans its drill-downs read. */
export const rangeNote = (h: H, subject: string): Html =>
	h.p(
		[h.Class("text-xs text-muted-foreground")],
		[`${subject} summaries cover the selected range; trace drill-downs show the latest 30 days.`],
	)

/** A loading table's title and column-header rows, sized like the loaded ones. */
export const tableSkeletonHead = (h: H, title: string): ReadonlyArray<Html> => [
	tableTitle(h, { title }),
	h.div([h.Class("h-8 border-b")]),
]
