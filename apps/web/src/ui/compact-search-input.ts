import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

// `CompactSearchInput`: a 24px mono filter field (magnifier, search input, clear button) for a
// panel toolbar. `searchInput` is the full-size control; this one sits beside table tabs.

export type CompactSearchInputOptions<M> = Readonly<{
	value: string
	placeholder?: string
	ariaLabel: string
	onInput: (value: string) => M
	onClear: M
	clearLabel?: string
	className?: string
}>

export const compactSearchInput = <M>(h: HtmlBuilder<M>, options: CompactSearchInputOptions<M>): Html =>
	h.label(
		[
			h.Class(
				cn(
					"flex h-6 items-center gap-1.5 rounded-sm border border-border-subtle bg-background/60 px-2 transition-colors focus-within:border-ring",
					options.className,
				),
			),
		],
		[
			icon(h, "MagnifierIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
			h.input([
				h.Type("search"),
				h.Value(options.value),
				h.OnInput(options.onInput),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				h.AriaLabel(options.ariaLabel),
				h.Class(
					"min-w-0 flex-1 bg-transparent font-mono text-2xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden",
				),
			]),
			...(options.value === ""
				? []
				: [
						h.button(
							[
								h.Type("button"),
								h.AriaLabel(options.clearLabel ?? "Clear filter"),
								h.OnClick(options.onClear),
								h.Class(
									"inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground active:text-foreground [&_svg]:size-3",
								),
							],
							[icon(h, "XmarkIcon")],
						),
					]),
		],
	)
