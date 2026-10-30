import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"

// `FilterChipRail` and `MonoLinkButton`: the active filters as removable chips, six until expanded.

const VISIBLE_LIMIT = 6

const CHIP_CLASS =
	"inline-flex items-center gap-1 rounded-sm border border-border/60 bg-background/60 py-0.5 pr-0.5 pl-1.5 font-mono text-3xs text-muted-foreground"

const MONO_LINK =
	"font-mono text-3xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"

export const monoLinkButton = <M>(
	h: HtmlBuilder<M>,
	onClick: M,
	children: ReadonlyArray<Html | string>,
	className?: string,
): Html => h.button([h.Type("button"), h.OnClick(onClick), h.Class(cn(MONO_LINK, className))], children)

export type FilterChip = Readonly<{ key: string; value: string; label: string }>

export const filterChipRail = <C extends FilterChip, M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		chips: ReadonlyArray<C>
		onRemove: (chip: C) => M
		onClear: M
		isExpanded: boolean
		onExpand: M
	}>,
): Html | null => {
	if (options.chips.length === 0) return null
	const visible = options.isExpanded ? options.chips : options.chips.slice(0, VISIBLE_LIMIT)
	const hidden = options.chips.length - visible.length
	return h.div(
		[h.Class("flex flex-wrap items-center gap-1.5"), h.AriaLabel("Active filters")],
		[
			...visible.map((chip) =>
				h.span(
					[h.Key(`${chip.key}:${chip.value}`), h.Class(CHIP_CLASS)],
					[
						h.span([h.Class("max-w-[22ch] truncate text-foreground/80")], [chip.label]),
						button(
							h,
							{
								variant: "ghost",
								size: "icon-2xs",
								className: "text-muted-foreground hover:text-foreground",
								attributes: [
									h.AriaLabel(`Remove ${chip.label}`),
									h.OnClick(options.onRemove(chip)),
								],
							},
							[icon(h, "XmarkIcon")],
						),
					],
				),
			),
			...(hidden > 0 ? [monoLinkButton(h, options.onExpand, ["+", String(hidden), " more"])] : []),
			monoLinkButton(h, options.onClear, ["Clear all"], "ml-1"),
		],
	)
}
