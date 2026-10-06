import type * as React from "react"
import { cn } from "../../lib/utils"
import { CopyButton } from "./copy-button"

type Layout = "split" | "grid" | "stacked" | "inline"

/**
 * Label/value list. `split` puts the value flush right on each row, `grid`
 * aligns labels in a fixed column, `stacked` puts the label above the value,
 * `inline` runs the pairs along one wrapping line (overline label, then value).
 */
export function KeyValueList({
	layout = "split",
	divided = false,
	valueFirst = false,
	className,
	...props
}: React.ComponentProps<"dl"> & {
	layout?: Layout
	/** Hairline between rows. */
	divided?: boolean
	/** `inline` only: the value leads and the label reads as its unit ("12 errors"). */
	valueFirst?: boolean
}): React.ReactElement {
	return (
		<dl
			className={cn(
				"text-xs",
				layout === "grid"
					? "grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-4 gap-y-1.5"
					: layout === "stacked"
						? "grid gap-3"
						: layout === "inline"
							? "flex flex-wrap items-baseline gap-x-4 gap-y-1"
							: "flex flex-col gap-1.5",
				divided && "gap-y-0 divide-y divide-border/60 [&>div]:py-1.5",
				className,
			)}
			data-layout={layout}
			data-value-first={valueFirst || undefined}
			data-label={layout === "inline" && !valueFirst ? "overline" : undefined}
			data-slot="key-value-list"
			{...props}
		/>
	)
}

export function KeyValue({
	label,
	children,
	mono = false,
	copyValue,
	wrap = false,
	title,
	className,
	valueClassName,
}: {
	label: React.ReactNode
	children: React.ReactNode
	/** Mono + tabular figures for ids, hashes and numbers. */
	mono?: boolean
	/** Adds a copy button for this raw string. */
	copyValue?: string
	/** Let the value wrap (long text, code blocks) instead of truncating. */
	wrap?: boolean
	/** Native tooltip for the whole pair, e.g. the untruncated value. */
	title?: string
	className?: string
	valueClassName?: string
}): React.ReactElement {
	return (
		<div
			className={cn(
				"min-w-0",
				"in-data-[layout=split]:flex in-data-[layout=split]:items-baseline in-data-[layout=split]:justify-between in-data-[layout=split]:gap-4",
				"in-data-[layout=grid]:col-span-2 in-data-[layout=grid]:grid in-data-[layout=grid]:grid-cols-subgrid",
				"in-data-[layout=stacked]:flex in-data-[layout=stacked]:flex-col in-data-[layout=stacked]:gap-0.5",
				"in-data-[layout=inline]:flex in-data-[layout=inline]:max-w-full in-data-[layout=inline]:items-baseline in-data-[layout=inline]:gap-1.5",
				"in-data-[value-first]:flex-row-reverse",
				className,
			)}
			title={title}
			data-slot="key-value"
		>
			<dt
				className={cn(
					"shrink-0 text-muted-foreground",
					"in-data-[label=overline]:text-3xs in-data-[label=overline]:font-medium in-data-[label=overline]:uppercase in-data-[label=overline]:tracking-[0.12em]",
				)}
			>
				{label}
			</dt>
			<dd
				className={cn(
					"flex min-w-0 items-center gap-1 text-foreground in-data-[layout=split]:justify-end in-data-[layout=split]:text-right",
					mono && "font-mono tabular-nums",
					valueClassName,
				)}
			>
				{wrap ? (
					<div className="min-w-0 break-words">{children}</div>
				) : (
					<span className="min-w-0 truncate">{children}</span>
				)}
				{copyValue ? <CopyButton value={copyValue} label={typeof label === "string" ? label : "value"} size="icon-xs" className="-my-1 shrink-0" /> : null}
			</dd>
		</div>
	)
}
