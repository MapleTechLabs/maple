import { ERROR_RATE_FILL, ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { meter } from "@maple/views/ui/meter"
import { pressable } from "@maple/views/ui/pressable"
import { selectableRow } from "@maple/views/ui/selectable-row"
import { sortButton } from "@maple/views/ui/table"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { SortState } from "../table-sort"

// The table chrome the tools pages share: open, mono, uppercase heads and 38px rows, with
// client-side column sorting.

/** Scrolls sideways once the fixed lanes outgrow the panel. */
export const toolTable = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>, className?: string): Html =>
	h.div([h.Class(cn("overflow-x-auto", className))], [h.div([h.Class("min-w-fit")], children)])

export const toolTableHead = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.div(
		[h.Class(cn("flex h-8 shrink-0 items-center gap-3 border-y border-border px-2.5", className))],
		children,
	)

export type ThOptions<M> = Readonly<{
	label: string
	width: string
	align?: "left" | "right"
	sortKey?: string
	sort?: SortState
	onSort?: (key: string) => M
	hidden?: string
}>

/** A column head, sortable when it has a key. */
export const th = <M>(h: HtmlBuilder<M>, options: ThOptions<M>): Html => {
	const { sortKey, onSort, sort } = options
	const isActive = sortKey !== undefined && sort?.key === sortKey
	return h.div(
		[
			h.Class(
				cn(
					"flex items-center",
					options.align === "right" && "justify-end",
					options.width,
					options.hidden,
				),
			),
		],
		[
			eyebrow(h, { variant: "mono" }, [
				sortKey === undefined || onSort === undefined
					? options.label
					: sortButton(
							h,
							{
								isActive,
								direction: sort?.dir ?? "desc",
								onClick: onSort(sortKey),
								align: options.align,
								className: "text-foreground-subtle",
							},
							[options.label],
						),
			]),
		],
	)
}

/** The rows, at full height; the page scrolls, not the table. */
export const toolTableBody = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	options: Readonly<{ isWaiting?: boolean }> = {},
): Html =>
	h.div(
		[
			h.Class(refreshingClass(options.isWaiting ?? false)),
			...(options.isWaiting === true ? [h.AriaBusy(true)] : []),
		],
		children,
	)

const ROW =
	"flex h-[38px] w-full shrink-0 items-center gap-3 border-b border-border-subtle px-2.5 text-left last:border-0 focus-visible:outline-none"

const rowClass = (isSelected: boolean, className?: string): string =>
	cn(
		ROW,
		!isSelected && "hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken",
		className,
	)

export type ToolTableRowOptions<M> = Readonly<{
	isSelected?: boolean
	/** A button row that toggles its selection: it carries `aria-pressed`. */
	isToggle?: boolean
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}> &
	({ onClick: M; href?: never } | { href: string; onClick?: never } | { onClick?: never; href?: never })

/** One 38px row in the selection lane: a button with `onClick`, a link with `href`. */
export const toolTableRow = <M>(
	h: HtmlBuilder<M>,
	options: ToolTableRowOptions<M>,
	children: ReadonlyArray<Html>,
): Html => {
	const isSelected = options.isSelected ?? false
	return options.onClick === undefined
		? selectableRow(
				h,
				{
					isSelected,
					href: options.href,
					className: rowClass(isSelected, options.className),
					attributes: options.attributes,
				},
				children,
			)
		: pressable(
				h,
				{
					onClick: options.onClick,
					isSelected: options.isToggle === true ? isSelected : undefined,
					selectedLane: isSelected,
					className: rowClass(isSelected, cn("focus-visible:ring-0", options.className)),
					attributes: options.attributes,
				},
				children,
			)
}

export const toolTableFooter = <M>(h: HtmlBuilder<M>, subject: string, detail: string): Html =>
	hstack(h, { gap: "2", align: "center", className: "h-9 px-2.5 font-mono text-xs" }, [
		typography(h, { tone: "muted" }, [subject]),
		typography(h, { tone: "subtle" }, [detail]),
	])

export const errorTone = (rate: number): Readonly<{ bar: string; text: string }> => {
	const level = errorRateLevel(rate)
	return {
		bar: ERROR_RATE_FILL[level],
		text: level === "neutral" ? "text-muted-foreground" : ERROR_RATE_TEXT[level],
	}
}

/** A bar scaled against the worst row, and the number. */
export const shareCell = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		ratio: number
		max: number
		label: string
		tone: Readonly<{ bar: string; text: string }>
	}>,
): Html =>
	hstack(h, { gap: "2.5", align: "center", justify: "end", as: "span", className: "w-36 shrink-0" }, [
		meter(h, {
			value: options.ratio,
			max: options.max,
			minVisible: 3,
			fillClassName: options.tone.bar,
			className: "hidden w-[60px] shrink-0 rounded-xs bg-muted @min-[560px]/panel:block",
		}),
		h.span(
			[h.Class(cn("w-[46px] text-right font-mono text-xs tabular-nums", options.tone.text))],
			[options.label],
		),
	])
