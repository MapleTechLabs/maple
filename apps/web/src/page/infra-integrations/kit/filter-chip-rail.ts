import type { Html, HtmlBuilder } from "foldkit/html"
import { removableChip } from "../../../ui/removable-chip"
import { textLink } from "../../../ui/text-link"
import { hstack } from "../../../ui/stack"

// `FilterChipRail`: the active filters as removable chips, six until expanded.

const VISIBLE_LIMIT = 6

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
	return hstack(h, { gap: "1.5", wrap: true, attributes: [h.AriaLabel("Active filters")] },
		[
			...visible.map((chip) =>
				removableChip(h, {
					label: chip.label,
					onRemove: options.onRemove(chip),
					attributes: [h.Key(`${chip.key}:${chip.value}`)],
				}),
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
