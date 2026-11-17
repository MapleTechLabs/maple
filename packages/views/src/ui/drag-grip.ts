import { Option } from "effect"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@maple/ui/lib/utils"
import { icon } from "./icon"
import { pressable } from "./pressable"

// `DragGrip`: the handle at the start of a reorderable row. The page's pointer listener finds it
// by an attribute it passes; the arrow keys move the row a slot without a pointer.

export type DragGripOptions<M> = Readonly<{
	/** `aria-label`, "Reorder <name>". */
	label: string
	/** ArrowUp is -1, ArrowDown 1. */
	onMove: (offset: -1 | 1) => M
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

/** A grip that drags its row to reorder it, and moves it a slot with ArrowUp and ArrowDown. */
export const dragGrip = <M>(h: HtmlBuilder<M>, options: DragGripOptions<M>): Html =>
	pressable(
		h,
		{
			label: options.label,
			className: cn(
				"shrink-0 cursor-grab touch-none text-foreground-faint hover:text-muted-foreground active:text-muted-foreground active:cursor-grabbing aria-disabled:cursor-progress",
				options.className,
			),
			attributes: [
				h.OnKeyDownPreventDefault((key) =>
					key === "ArrowUp"
						? Option.some(options.onMove(-1))
						: key === "ArrowDown"
							? Option.some(options.onMove(1))
							: Option.none(),
				),
				...(options.attributes ?? []),
			],
		},
		[icon(h, "GripDotsIcon", { size: 14 })],
	)
