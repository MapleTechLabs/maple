import type { StatusPageId } from "@maple/domain"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { lockedControl } from "@maple/views/ui/locked-control"
import type { MenuItemEntry } from "@maple/views/ui/menu-view"
import { type PublicPageLink, statusPageViewHref } from "./commands"

// The two ways to open a page, on the list's cards and in the editor's "..." menu: the public page
// visitors read, and the dev preview inside Maple.

export const OPEN_PUBLIC_LABEL = "Open public page"
export const OPEN_PREVIEW_LABEL = "Open dev preview"

/** Menu values for the two open actions. */
export const OPEN_PUBLIC_VALUE = "open-public"
export const OPEN_PREVIEW_VALUE = "open-preview"

/** The accessible name: the visible label, plus the page where several cards share the label. */
const nameOf = <M>(h: HtmlBuilder<M>, label: string, pageName: string | undefined) =>
	pageName === undefined ? [] : [h.AriaLabel(`${label} for ${pageName}`)]

/** The public page in a new tab; disabled, with the reason as its tooltip, while there is none. */
export const openPublicPageButton = <M>(h: HtmlBuilder<M>, link: PublicPageLink, pageName?: string): Html =>
	link._tag === "Open"
		? linkButton(
				h,
				{
					size: "sm",
					variant: "outline",
					href: link.url,
					attributes: [
						h.Target("_blank"),
						h.Rel("noopener"),
						...nameOf(h, OPEN_PUBLIC_LABEL, pageName),
					],
				},
				[icon(h, "ExternalLinkIcon"), OPEN_PUBLIC_LABEL],
			)
		: lockedControl(
				h,
				link.reason,
				button(
					h,
					{
						size: "sm",
						variant: "outline",
						isDisabled: true,
						attributes: nameOf(h, OPEN_PUBLIC_LABEL, pageName),
					},
					[icon(h, "ExternalLinkIcon"), OPEN_PUBLIC_LABEL],
				),
			)

/** The page inside Maple, for members: always available. */
export const openPreviewButton = <M>(h: HtmlBuilder<M>, pageId: StatusPageId, pageName?: string): Html =>
	linkButton(
		h,
		{
			size: "sm",
			variant: "outline",
			href: statusPageViewHref(pageId),
			attributes: nameOf(h, OPEN_PREVIEW_LABEL, pageName),
		},
		[icon(h, "EyeIcon"), OPEN_PREVIEW_LABEL],
	)

/** The same two actions as menu items. */
export const openMenuEntries = (link: PublicPageLink): ReadonlyArray<MenuItemEntry> => [
	{
		_tag: "Item",
		value: OPEN_PUBLIC_VALUE,
		label: OPEN_PUBLIC_LABEL,
		icon: "ExternalLinkIcon",
		...(link._tag === "Unavailable"
			? { isDisabled: true, tooltip: { content: [link.reason], side: "left" } }
			: undefined),
	},
	{ _tag: "Item", value: OPEN_PREVIEW_VALUE, label: OPEN_PREVIEW_LABEL, icon: "EyeIcon" },
]
