import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `Column`: a cell's width in a row of flex cells (a div table's head and rows): a flexible
// column that takes the free width over a floor (`min`), or a fixed lane (`width`).

export type ColumnMin = "0" | "48" | "52" | "56" | "60" | "64"
export type ColumnWidth = "28" | "36" | "44"

const MIN = {
	"0": "min-w-0",
	"48": "min-w-48",
	"52": "min-w-52",
	"56": "min-w-56",
	"60": "min-w-60",
	"64": "min-w-64",
} as const satisfies Record<ColumnMin, string>

const WIDTH = {
	"28": "w-28",
	"36": "w-36",
	"44": "w-44",
} as const satisfies Record<ColumnWidth, string>

export type ColumnOptions<M> = Readonly<{
	/** A flexible column (`w-0 flex-1`) that never drops below this floor. */
	min?: ColumnMin
	/** A fixed lane's width; ignored when `min` is set. */
	width?: ColumnWidth
	/** `false`: `shrink-0`, the lane keeps its width when the row is tight. */
	shrink?: boolean
	/** `pl-4` or `pl-6`, room from the column before it. */
	inset?: "4" | "6"
	/** Hidden below this breakpoint (`hidden md:block`). */
	from?: "md"
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

/** `column`'s classes, for a cell the kit already renders (a column head's `width`). */
export const columnClass = (options: Omit<ColumnOptions<never>, "attributes">): string =>
	cn(
		options.min !== undefined && ["w-0 flex-1", MIN[options.min]],
		options.min === undefined && options.width !== undefined && WIDTH[options.width],
		options.shrink === false && "shrink-0",
		options.inset === "4" && "pl-4",
		options.inset === "6" && "pl-6",
		options.from === "md" && "hidden md:block",
		options.className,
	)

/** A row cell (a `div`) at a column's width. */
export const column = <M>(
	h: HtmlBuilder<M>,
	options: ColumnOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => h.div([h.Class(columnClass(options)), ...(options.attributes ?? [])], children)
