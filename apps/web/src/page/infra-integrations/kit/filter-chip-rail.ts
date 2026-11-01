import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { textLink } from "../../../ui/text-link"

// `FilterChipRail`: the active filters as removable chips, six until expanded.

const VISIBLE_LIMIT = 6

const CHIP_CLASS =
	"inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-background/60 py-0.5 pr-0.5 pl-1.5 font-mono text-3xs text-muted-foreground"

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
						h.span([h.Class("max-w-[22ch] truncate text-foreground-soft")], [chip.label]),
						button(
							h,
							{
								variant: "ghost",
								size: "icon-2xs",
								className: "text-muted-foreground hover:text-foreground active:text-foreground",
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
			...(hidden > 0
				? [
						textLink(
							h,
							{ tone: "muted", isMono: true, className: "text-3xs", onClick: options.onExpand },
							["+", String(hidden), " more"],
						),
					]
				: []),
			textLink(
				h,
				{ tone: "muted", isMono: true, className: "ml-1 text-3xs", onClick: options.onClear },
				["Clear all"],
			),
		],
	)
}
