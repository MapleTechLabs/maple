import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `Spaced`: a block whose children stack with `space-y-*` margins (not a flex column), usually a
// row's text column that fills the free width and lets its lines truncate.

export type SpacedSpace = "0.5" | "1" | "2"

const SPACE = {
	"0.5": "space-y-0.5",
	"1": "space-y-1",
	"2": "space-y-2",
} as const satisfies Record<SpacedSpace, string>

export type SpacedOptions<M> = Readonly<{
	space: SpacedSpace
	/** `min-w-0 flex-1`: fills a flex row's free width and can shrink below its content. */
	fill?: boolean
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

/** `spaced`'s classes, for an element the kit already renders. */
export const spacedClass = (options: Omit<SpacedOptions<never>, "attributes">): string =>
	cn((options.fill ?? false) && "min-w-0 flex-1", SPACE[options.space], options.className)

/** A spaced `div`. */
export const spaced = <M>(
	h: HtmlBuilder<M>,
	options: SpacedOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => h.div([h.Class(spacedClass(options)), ...(options.attributes ?? [])], children)
