import { cn } from "@maple/ui/lib/utils"
import {
	cardActionStyles,
	cardDescriptionStyles,
	cardFooterStyles,
	cardHeaderStyles,
	cardPanelStyles,
	cardStyles,
	cardTitleStyles,
} from "@maple/ui/styles/ui/card"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/card.tsx: the raised rounded-2xl surface and its parts.

type Children = ReadonlyArray<Html | string>

const part =
	(styles: string, slot: string) =>
	<M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
		h.div([h.Class(cn(styles, className)), h.DataAttribute("slot", slot)], children)

export const card = part(cardStyles, "card")
export const cardHeader = part(cardHeaderStyles, "card-header")
export const cardTitle = part(cardTitleStyles, "card-title")
export const cardDescription = part(cardDescriptionStyles, "card-description")
export const cardAction = part(cardActionStyles, "card-action")
export const cardPanel = part(cardPanelStyles, "card-panel")
export const cardFooter = part(cardFooterStyles, "card-footer")
