import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { badge } from "../../ui/display"
import { icon } from "../../ui/icon"

/**
 * `PinnedNamespaceNotice`: replaces a
 * rail's Namespace section while the org-global pin is on. `onClear` should end in the page's
 * `PageOutMessage.RequestedNamespacePin({ maybeNamespace: Option.none() })`.
 */
export const pinnedNamespaceNotice = <M>(h: HtmlBuilder<M>, namespace: string, onClear?: M): Html =>
	h.div(
		[],
		[
			h.div(
				[
					h.Class(
						cn(
							"flex w-full items-center justify-between gap-2 py-2 text-muted-foreground",
							eyebrowVariants({ variant: "label" }),
						),
					),
				],
				[
					h.span([h.Class("truncate")], ["Namespace"]),
					button(
						h,
						{
							variant: "link",
							size: "xs",
							className:
								"h-auto p-0 text-2xs normal-case tracking-normal text-muted-foreground hover:text-foreground active:text-foreground sm:text-2xs",
							attributes: onClear === undefined ? [] : [h.OnClick(onClear)],
						},
						["Clear"],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2 py-1 text-sm")],
				[
					icon(h, "LayersIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
					h.span([h.Class("truncate")], [namespace]),
					badge(
						h,
						{
							variant: "tag",
							className: "ml-auto",
							attributes: [h.Title("Pinned for the whole app in the org menu")],
						},
						["Pinned"],
					),
				],
			),
		],
	)
