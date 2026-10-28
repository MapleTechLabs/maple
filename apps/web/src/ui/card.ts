import { cn } from "@maple/ui/lib/utils"
import {
	cardDescriptionStyles,
	cardFooterStyles,
	cardHeaderStyles,
	cardPanelStyles,
	cardStyles,
	cardTitleStyles,
} from "@maple/ui/styles/ui/card"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/card.tsx: the raised rounded-2xl surface and its parts.

type Children = ReadonlyArray<Html | string>

const part =
	(styles: string, slot: string) =>
	<M>(
		h: HtmlBuilder<M>,
		children: Children,
		className?: string,
		attributes: ReadonlyArray<Attribute<M>> = [],
	): Html =>
		h.div([h.Class(cn(styles, className)), h.DataAttribute("slot", slot), ...attributes], children)

export const card = part(cardStyles, "card")
export const cardHeader = part(cardHeaderStyles, "card-header")
// A card's title and description are prose, in the same sans faces as dialog and alert copy.
export const cardTitle = part(cn(cardTitleStyles, "font-display tracking-tight"), "card-title")
export const cardDescription = part(cn(cardDescriptionStyles, "font-prose"), "card-description")
export const cardPanel = part(cardPanelStyles, "card-panel")
export const cardFooter = part(cardFooterStyles, "card-footer")
