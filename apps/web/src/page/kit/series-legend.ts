import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

export type SeriesLegendSwatch = "dot" | "square" | "line" | "dashed"

export interface SeriesLegendItem {
	readonly key: string
	readonly label?: Html | string
	readonly title?: string
	readonly color?: string
	/** The value: a number renders as its own text node. */
	readonly value?: Html | string | number
	readonly swatch?: SeriesLegendSwatch
}

const VARIANTS = {
	inline: {
		root: "flex flex-wrap items-center justify-end gap-x-3 gap-y-1",
		item: "inline-flex min-w-0 items-baseline gap-1.5",
		dot: "size-1.5 translate-y-[-1px]",
		label: "max-w-[24ch] truncate text-2xs text-muted-foreground",
		value: "font-mono text-2xs text-foreground-soft tabular-nums",
	},
	chip: {
		root: "flex flex-wrap items-center gap-2",
		item: "inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-2xs",
		dot: "size-2",
		label: "font-medium text-foreground-soft",
		value: "font-mono text-muted-foreground tabular-nums",
	},
} as const

const swatch = <M>(h: HtmlBuilder<M>, kind: SeriesLegendSwatch, color: string, size: string): Html => {
	switch (kind) {
		case "line":
			return h.span([
				h.AriaHidden(true),
				h.Class("h-0.5 w-3 shrink-0 self-center rounded-full"),
				h.Style({ background: color }),
			])
		case "dashed":
			return h.span([
				h.AriaHidden(true),
				h.Class("w-3 shrink-0 self-center border-t border-dashed"),
				h.Style({ "border-color": color }),
			])
		case "square":
			return h.span([
				h.AriaHidden(true),
				h.Class(cn(size, "shrink-0 rounded-xs")),
				h.Style({ background: color }),
			])
		case "dot":
			return h.span([
				h.AriaHidden(true),
				h.Class(cn(size, "shrink-0 rounded-full")),
				h.Style({ background: color }),
			])
	}
}

export const seriesLegend = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		items: ReadonlyArray<SeriesLegendItem>
		variant?: keyof typeof VARIANTS
		swatch?: SeriesLegendSwatch
		maxItems?: number
		className?: string
	}>,
): Html => {
	const styles = VARIANTS[options.variant ?? "inline"]
	const shown = options.maxItems === undefined ? options.items : options.items.slice(0, options.maxItems)
	const overflow = options.items.length - shown.length
	return h.div(
		[h.Class(cn(styles.root, options.className))],
		[
			...shown.map((item) =>
				h.span(
					[h.Key(item.key), h.Class(styles.item)],
					[
						...(item.color === undefined
							? []
							: [swatch(h, item.swatch ?? options.swatch ?? "dot", item.color, styles.dot)]),
						...(item.label === undefined
							? []
							: [
									h.span(
										[
											h.Class(styles.label),
											...(item.title === undefined ? [] : [h.Title(item.title)]),
										],
										[item.label],
									),
								]),
						...(item.value === undefined
							? []
							: [
									h.span(
										[h.Class(styles.value)],
										[typeof item.value === "number" ? String(item.value) : item.value],
									),
								]),
					],
				),
			),
			...(overflow > 0
				? [h.span([h.Class("text-2xs text-foreground-subtle")], ["+", String(overflow)])]
				: []),
		],
	)
}
