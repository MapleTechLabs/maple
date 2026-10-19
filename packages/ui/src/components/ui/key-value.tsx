import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	keyValueCopyButtonStyles,
	keyValueGridStyles,
	keyValueInlineStyles,
	keyValueLabelOverlineStyles,
	keyValueLabelStyles,
	keyValueListDividedStyles,
	keyValueListGridStyles,
	keyValueListInlineStyles,
	keyValueListSplitStyles,
	keyValueListStackedStyles,
	keyValueListStyles,
	keyValueSplitStyles,
	keyValueStackedStyles,
	keyValueStyles,
	keyValueValueFirstStyles,
	keyValueValueMonoStyles,
	keyValueValueStyles,
	keyValueValueTruncateStyles,
	keyValueValueWrapStyles,
} from "./key-value.styles"
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
				keyValueListStyles,
				layout === "grid"
					? keyValueListGridStyles
					: layout === "stacked"
						? keyValueListStackedStyles
						: layout === "inline"
							? keyValueListInlineStyles
							: keyValueListSplitStyles,
				divided && keyValueListDividedStyles,
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
				keyValueStyles,
				keyValueSplitStyles,
				keyValueGridStyles,
				keyValueStackedStyles,
				keyValueInlineStyles,
				keyValueValueFirstStyles,
				className,
			)}
			title={title}
			data-slot="key-value"
		>
			<dt className={cn(keyValueLabelStyles, keyValueLabelOverlineStyles)}>{label}</dt>
			<dd className={cn(keyValueValueStyles, mono && keyValueValueMonoStyles, valueClassName)}>
				{wrap ? (
					<div className={keyValueValueWrapStyles}>{children}</div>
				) : (
					<span className={keyValueValueTruncateStyles}>{children}</span>
				)}
				{copyValue ? (
					<CopyButton
						value={copyValue}
						label={typeof label === "string" ? label : "value"}
						size="icon-xs"
						className={keyValueCopyButtonStyles}
					/>
				) : null}
			</dd>
		</div>
	)
}
