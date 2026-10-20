"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	ROW_LANE,
	listRowBodyStyles,
	listRowLeadingStyles,
	listRowMetaStyles,
	listRowTitleStyles,
	listRowTrailingStyles,
	listRowVariants,
	rowSelectedClass,
} from "./list-row.styles"

export { ROW_LANE, listRowVariants, rowSelectedClass }

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
					<span className={listRowLeadingStyles} data-slot="list-row-leading">
						{leading}
					</span>
				) : null}
				<span className={listRowBodyStyles}>
					<span className={listRowTitleStyles} data-slot="list-row-title">
						{title}
					</span>
					{meta != null ? (
						<span className={listRowMetaStyles} data-slot="list-row-meta">
							{meta}
						</span>
					) : null}
				</span>
				{trailing != null ? (
					<span className={listRowTrailingStyles} data-slot="list-row-trailing">
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
