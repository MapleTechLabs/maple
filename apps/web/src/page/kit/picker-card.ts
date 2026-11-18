import type { Html, HtmlBuilder } from "foldkit/html"
import { cardButton, cardLink } from "@maple/views/ui/card-button"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// A provider in a picker grid (`/sources/new`, the Cost page's add dialog): its tile, name and
// what it brings in, as one card that acts in place or navigates.

export type PickerCardOptions<M> = Readonly<{
	/** Keys the card among its siblings, so a search that filters the grid keeps each card's node. */
	key: string
	leading: Html
	title: string
	description: string
	/** `2`: the description wraps to a second line before it truncates, for a card in a narrow grid. */
	descriptionLines?: 1 | 2
	/** Beside the name, before the chevron: a "Connected" or "Added" badge. */
	trailing?: Html | null
	action: Readonly<{ onClick: M; isDisabled?: boolean }> | Readonly<{ href: string }>
}>

/** A provider card for a picker grid: tile, name, one muted line, and a chevron on hover. */
export const pickerCard = <M>(h: HtmlBuilder<M>, options: PickerCardOptions<M>): Html => {
	const isDisabled = "onClick" in options.action && options.action.isDisabled === true
	const children = [
		options.leading,
		vstack(h, { gap: "0.5", shrink: true, grow: true, as: "span" }, [
			typography(h, { size: "sm", weight: "medium", truncate: true }, [options.title]),
			options.descriptionLines === 2
				? typography(h, { size: "xs", tone: "muted", className: "line-clamp-2 font-prose" }, [
						options.description,
					])
				: typography(h, { size: "xs", tone: "muted", truncate: true, className: "font-prose" }, [
						options.description,
					]),
		]),
		...(options.trailing === undefined || options.trailing === null ? [] : [options.trailing]),
		...(isDisabled ? [] : [revealIcon(h, "ChevronRightIcon")]),
	]
	const layout = { className: "flex items-center gap-3 px-3 py-3", attributes: [h.Key(options.key)] }
	return "href" in options.action
		? cardLink(h, { ...layout, href: options.action.href }, children)
		: cardButton(h, { ...layout, onClick: options.action.onClick, isDisabled }, children)
}
