import { cn } from "@maple/ui/lib/utils"
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
} from "@maple/ui/styles/ui/key-value"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type CopyStatus, copyButton } from "./copy-button"

// Port of packages/ui/src/components/ui/key-value.tsx. The copy state lives in the caller's Model.

type Children = ReadonlyArray<Html | string>
export type KeyValueLayout = "split" | "grid" | "stacked" | "inline"

const LIST_LAYOUT_STYLES = {
	split: keyValueListSplitStyles,
	grid: keyValueListGridStyles,
	stacked: keyValueListStackedStyles,
	inline: keyValueListInlineStyles,
} as const satisfies Record<KeyValueLayout, string>

export const keyValueList = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly layout?: KeyValueLayout
		readonly divided?: boolean
		readonly valueFirst?: boolean
		readonly className?: string
	},
	children: ReadonlyArray<Html>,
): Html => {
	const layout = options.layout ?? "split"
	const valueFirst = options.valueFirst ?? false
	return h.dl(
		[
			h.Class(
				cn(
					keyValueListStyles,
					LIST_LAYOUT_STYLES[layout],
					options.divided === true && keyValueListDividedStyles,
					options.className,
				),
			),
			h.DataAttribute("layout", layout),
			...(valueFirst ? [h.DataAttribute("value-first", "true")] : []),
			...(layout === "inline" && !valueFirst ? [h.DataAttribute("label", "overline")] : []),
			h.DataAttribute("slot", "key-value-list"),
		],
		children,
	)
}

export interface KeyValueCopy<M> {
	readonly status: CopyStatus
	readonly onCopy: M
}

export interface KeyValueOptions<M> {
	readonly label: string
	/** A rich label (`label={<Eyebrow>…</Eyebrow>}`); `label` still names the copy button. */
	readonly labelContent?: Html
	readonly mono?: boolean
	/** Adds a copy button; the caller's Model owns its status. */
	readonly copy?: KeyValueCopy<M>
	readonly wrap?: boolean
	readonly title?: string
	readonly className?: string
	readonly valueClassName?: string
}

export const keyValue = <M>(h: HtmlBuilder<M>, options: KeyValueOptions<M>, children: Children): Html =>
	h.div(
		[
			h.Class(
				cn(
					keyValueStyles,
					keyValueSplitStyles,
					keyValueGridStyles,
					keyValueStackedStyles,
					keyValueInlineStyles,
					keyValueValueFirstStyles,
					options.className,
				),
			),
			...(options.title === undefined ? [] : [h.Title(options.title)]),
			h.DataAttribute("slot", "key-value"),
		],
		[
			h.dt(
				[h.Class(cn(keyValueLabelStyles, keyValueLabelOverlineStyles))],
				[options.labelContent ?? options.label],
			),
			h.dd(
				[
					h.Class(
						cn(
							keyValueValueStyles,
							options.mono === true && keyValueValueMonoStyles,
							options.valueClassName,
						),
					),
				],
				[
					options.wrap === true
						? h.div([h.Class(keyValueValueWrapStyles)], children)
						: h.span([h.Class(keyValueValueTruncateStyles)], children),
					...(options.copy === undefined
						? []
						: [
								copyButton(h, {
									label: options.labelContent === undefined ? options.label : "value",
									status: options.copy.status,
									size: "icon-xs",
									className: keyValueCopyButtonStyles,
									onClick: options.copy.onCopy,
								}),
							]),
				],
			),
		],
	)
