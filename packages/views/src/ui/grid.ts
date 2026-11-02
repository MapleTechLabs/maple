import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `Grid`: a CSS grid of equal columns with its gap on the spacing scale, two columns side by side
// at every width or from a breakpoint up, instead of a hand-written `grid gap-4 lg:grid-cols-2`.

export type GridGap = "2" | "3" | "4" | "6"

const GAP = { "2": "gap-2", "3": "gap-3", "4": "gap-4", "6": "gap-6" } as const satisfies Record<
	GridGap,
	string
>
const GAP_X = { "6": "gap-x-6" } as const
const GAP_Y = { "4": "gap-y-4" } as const

export type GridOptions<M> = Readonly<{
	/** Columns at every width (`grid-cols-1` keeps one column explicit below a breakpoint). */
	cols?: 1 | 2
	/** Two columns from `sm` up. */
	sm?: 2
	/** Two columns from `lg` up. */
	lg?: 2
	gap?: GridGap
	/** Column and row gaps apart, when they differ. */
	gapX?: keyof typeof GAP_X
	gapY?: keyof typeof GAP_Y
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

/** `grid`'s classes, for an element the kit already renders (a radio group). */
export const gridClass = (options: Omit<GridOptions<never>, "attributes">): string =>
	cn(
		"grid",
		options.cols === 1 && "grid-cols-1",
		options.cols === 2 && "grid-cols-2",
		options.sm === 2 && "sm:grid-cols-2",
		options.lg === 2 && "lg:grid-cols-2",
		options.gap === undefined ? undefined : GAP[options.gap],
		options.gapX === undefined ? undefined : GAP_X[options.gapX],
		options.gapY === undefined ? undefined : GAP_Y[options.gapY],
		options.className,
	)

/** A grid `div`. */
export const grid = <M>(
	h: HtmlBuilder<M>,
	options: GridOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => h.div([h.Class(gridClass(options)), ...(options.attributes ?? [])], children)
