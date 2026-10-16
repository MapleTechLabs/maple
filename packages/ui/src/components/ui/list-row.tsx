"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"

// The 2px left lane a selectable row draws its selection in, reserved on every row and painted
// only on the selected one so contents never shift as selection moves (the sidebar's idiom).
export const ROW_LANE =
	"relative before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors"

/** Lane + tint for a selected row, transparent lane otherwise. */
export function rowSelectedClass(selected: boolean | undefined): string {
	return cn(ROW_LANE, selected ? "bg-muted/40 before:bg-primary" : "before:bg-transparent")
}

export const listRowVariants = cva(
	"flex w-full min-w-0 items-center gap-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
	{
		defaultVariants: { density: "default", divided: false },
		variants: {
			density: {
				compact: "px-3 py-1.5 text-xs",
				default: "px-4 py-2.5 text-sm",
			},
			divided: {
				false: "",
				true: "border-b border-border/60 last:border-b-0",
			},
		},
	},
)

export interface ListRowProps extends Omit<useRender.ComponentProps<"div">, "title"> {
	density?: VariantProps<typeof listRowVariants>["density"]
	/** Hairline between rows (the last row drops it). */
	divided?: boolean
	selected?: boolean
	leading?: React.ReactNode
	title: React.ReactNode
	/** Secondary line under the title. */
	meta?: React.ReactNode
	trailing?: React.ReactNode
}

/** Icon + title + meta + trailing row. Pass `render` to make it a Link or button. */
export function ListRow({
	density,
	divided = false,
	selected,
	leading,
	title,
	meta,
	trailing,
	className,
	render,
	...props
}: ListRowProps): React.ReactElement {
	const defaultProps = {
		"aria-current": selected ? ("true" as const) : undefined,
		children: (
			<>
				{leading != null ? (
					<span
						className="flex shrink-0 items-center text-muted-foreground"
						data-slot="list-row-leading"
					>
						{leading}
					</span>
				) : null}
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground" data-slot="list-row-title">
						{title}
					</span>
					{meta != null ? (
						<span className="truncate text-muted-foreground text-xs" data-slot="list-row-meta">
							{meta}
						</span>
					) : null}
				</span>
				{trailing != null ? (
					<span className="flex shrink-0 items-center gap-2" data-slot="list-row-trailing">
						{trailing}
					</span>
				) : null}
			</>
		),
		className: cn(
			listRowVariants({ density, divided }),
			selected !== undefined && rowSelectedClass(selected),
			className,
		),
		"data-selected": selected ? "" : undefined,
		"data-slot": "list-row",
	}
	return useRender({ defaultTagName: "div", props: mergeProps<"div">(defaultProps, props), render })
}
