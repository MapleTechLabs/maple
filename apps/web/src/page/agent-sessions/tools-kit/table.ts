import { ERROR_RATE_FILL, ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { meter } from "../../../ui/meter"

// The table chrome the tools pages share: open,
// mono, uppercase heads and 38px rows, with client-side column sorting.

export type SortDir = "asc" | "desc"
export type SortState = Readonly<{ key: string | null; dir: SortDir }>

/** `useSortState`'s `handleSort`: the active column flips, another starts desc (asc for text keys). */
export const nextSort = (current: SortState, key: string, stringKeys: ReadonlyArray<string>): SortState =>
	key === current.key
		? { key, dir: current.dir === "asc" ? "desc" : "asc" }
		: { key, dir: stringKeys.includes(key) ? "asc" : "desc" }

export type SortValue = string | number | undefined

const isNumericString = (value: SortValue): value is string =>
	typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))

/** `compareValues`: numeric when both sides are numbers (or numeric strings), else text. */
const compareValues = (av: SortValue, bv: SortValue, dir: SortDir): number => {
	const numeric =
		(typeof av === "number" && typeof bv === "number") || (isNumericString(av) && isNumericString(bv))
	if (numeric) {
		const cmp = Number(av) < Number(bv) ? -1 : Number(av) > Number(bv) ? 1 : 0
		return dir === "asc" ? cmp : -cmp
	}
	return dir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
}

export const sortRows = <Row>(
	rows: ReadonlyArray<Row>,
	sort: SortState,
	read: (row: Row, key: string) => SortValue,
): ReadonlyArray<Row> => {
	const { key } = sort
	return key === null ? rows : rows.toSorted((a, b) => compareValues(read(a, key), read(b, key), sort.dir))
}

/** `ToolTable`: scrolls sideways once the fixed lanes outgrow the panel. */
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

/** `Th`: a column head, sortable when it has a key. */
export const th = <M>(h: HtmlBuilder<M>, options: ThOptions<M>): Html => {
	const { sortKey, onSort, sort } = options
	const isActive = sortKey !== undefined && sort?.key === sortKey
	const text = cn(eyebrowVariants({ variant: "mono" }), "transition-colors")
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
			sortKey === undefined || onSort === undefined
				? eyebrow(h, { variant: "mono" }, [options.label])
				: h.button(
						[
							h.Class(
								cn(
									"inline-flex items-center gap-1",
									text,
									isActive ? "text-foreground" : "hover:text-foreground",
								),
							),
							h.Type("button"),
							h.OnClick(onSort(sortKey)),
						],
						[
							options.label,
							icon(h, "ArrowUpDownIcon", {
								size: 9,
								className: cn(
									"transition-opacity",
									isActive ? "text-primary opacity-100" : "opacity-0",
									isActive && sort?.dir === "asc" && "rotate-180",
								),
							}),
						],
					),
		],
	)
}

/** `ToolTableBody`: the rows, at full height; the page scrolls, not the table. */
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
	"flex h-[38px] w-full shrink-0 items-center gap-3 border-b border-border/50 px-2.5 text-left transition-colors last:border-0 focus-visible:outline-none"

export const toolRowClass = (isSelected: boolean): string =>
	cn(ROW, rowSelectedClass(isSelected), !isSelected && "hover:bg-muted/30 focus-visible:bg-muted/30")

export const toolTableFooter = <M>(h: HtmlBuilder<M>, subject: string, detail: string): Html =>
	h.div(
		[h.Class("flex h-9 items-center gap-[9px] px-2.5 font-mono text-xs")],
		[
			h.span([h.Class("text-muted-foreground")], [subject]),
			h.span([h.Class("text-muted-foreground/60")], [detail]),
		],
	)

export const errorTone = (rate: number): Readonly<{ bar: string; text: string }> => {
	const level = errorRateLevel(rate)
	return {
		bar: ERROR_RATE_FILL[level],
		text: level === "neutral" ? "text-muted-foreground" : ERROR_RATE_TEXT[level],
	}
}

/** `ShareCell`: a bar scaled against the worst row, and the number. */
export const shareCell = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		ratio: number
		max: number
		label: string
		tone: Readonly<{ bar: string; text: string }>
	}>,
): Html =>
	h.span(
		[h.Class("flex w-[150px] shrink-0 items-center justify-end gap-2.5")],
		[
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
		],
	)
