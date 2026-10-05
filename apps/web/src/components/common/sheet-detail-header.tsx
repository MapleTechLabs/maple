import type * as React from "react"

import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { SheetDescription, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import { cn } from "@maple/ui/lib/utils"

/**
 * Header of a peek/detail sheet: kind eyebrow, mono title, optional meta row.
 * `pr-14` leaves room for the sheet's own close button.
 */
export function SheetDetailHeader({
	kind,
	title,
	adornment,
	description,
	meta,
	mono = true,
	className,
}: {
	/** "Trace", "Pod", "Action". */
	kind?: React.ReactNode
	title: React.ReactNode
	/** Status badge beside the title. */
	adornment?: React.ReactNode
	/** Screen-reader description of the sheet; required by the dialog semantics. */
	description: string
	/** Chips/facts row under the title. */
	meta?: React.ReactNode
	mono?: boolean
	className?: string
}) {
	return (
		<SheetHeader className={cn("gap-1.5 pr-14", className)}>
			{kind ? <Eyebrow>{kind}</Eyebrow> : null}
			<SheetTitle
				className={cn(
					"flex flex-wrap items-center gap-2 text-[15px] leading-tight",
					mono && "font-mono",
				)}
			>
				<span className={cn("min-w-0", mono ? "break-all" : "break-words")}>{title}</span>
				{adornment}
			</SheetTitle>
			<SheetDescription className="sr-only">{description}</SheetDescription>
			{meta ? <div className="flex flex-wrap items-center gap-1.5">{meta}</div> : null}
		</SheetHeader>
	)
}
