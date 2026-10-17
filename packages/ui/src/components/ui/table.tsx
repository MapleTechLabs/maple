import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	tableBodyStyles,
	tableCaptionStyles,
	tableCellStyles,
	tableContainerScrollStyles,
	tableContainerStyles,
	tableFooterStyles,
	tableHeadStyles,
	tableHeaderStickyStyles,
	tableHeaderStyles,
	tableRowStyles,
	tableStyles,
	truncatedCellStyles,
} from "./table.styles"

export type TableVariant = "default" | "card" | "bare"
/** Row density. `sm` is the dense text-xs table; `xs` the 11px inline table (chat renderers, previews). */
export type TableSize = "default" | "sm" | "xs"

export function Table({
	className,
	variant = "default",
	size = "default",
	scroll = true,
	...props
}: React.ComponentProps<"table"> & {
	variant?: TableVariant
	size?: TableSize
	/**
	 * Wrap in a horizontal scroll container. Turn off when an ancestor already
	 * scrolls (virtualized lists): the wrapper would capture a sticky header.
	 */
	scroll?: boolean
}): React.ReactElement {
	return (
		<div
			className={cn(tableContainerStyles, scroll && tableContainerScrollStyles)}
			data-slot="table-container"
			data-variant={variant}
			data-size={size}
		>
			<table className={cn(tableStyles, className)} data-slot="table" {...props} />
		</div>
	)
}

export function TableHeader({
	className,
	sticky = false,
	...props
}: React.ComponentProps<"thead"> & {
	/** Pin to the top of the nearest scrolling ancestor. Pair with `<Table scroll={false}>`. */
	sticky?: boolean
}): React.ReactElement {
	return (
		<thead
			className={cn(tableHeaderStyles, sticky && tableHeaderStickyStyles, className)}
			data-slot="table-header"
			{...props}
		/>
	)
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">): React.ReactElement {
	return <tbody className={cn(tableBodyStyles, className)} data-slot="table-body" {...props} />
}

export function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">): React.ReactElement {
	return <tfoot className={cn(tableFooterStyles, className)} data-slot="table-footer" {...props} />
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.ReactElement {
	return <tr className={cn(tableRowStyles, className)} data-slot="table-row" {...props} />
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">): React.ReactElement {
	return <th className={cn(tableHeadStyles, className)} data-slot="table-head" {...props} />
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">): React.ReactElement {
	return <td className={cn(tableCellStyles, className)} data-slot="table-cell" {...props} />
}

/**
 * A cell whose text truncates instead of widening the table. Plain `truncate`
 * inside an auto-layout `TableCell` never fires (cells are nowrap and size to
 * content); `max-w-0 w-full` makes this column take the leftover width.
 */
export function TruncatedCell({ className, ...props }: React.ComponentProps<"td">): React.ReactElement {
	return <TableCell className={cn(truncatedCellStyles, className)} {...props} />
}

export function TableCaption({ className, ...props }: React.ComponentProps<"caption">): React.ReactElement {
	return <caption className={cn(tableCaptionStyles, className)} data-slot="table-caption" {...props} />
}
