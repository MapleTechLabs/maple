import { cn } from "@maple/ui/lib/utils"
import {
	emptyContentStyles,
	emptyDescriptionStyles,
	emptyHeaderStyles,
	emptyMediaStackLeftStyles,
	emptyMediaStackRightStyles,
	emptyMediaStyles,
	emptyMediaVariants,
	emptyMessageDashedStyles,
	emptyMessageStyles,
	emptyStyles,
	emptyTitleStyles,
} from "@maple/ui/styles/ui/empty"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/empty.tsx.

type Children = ReadonlyArray<Html | string>

const part =
	(styles: string, slot: string) =>
	<M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
		h.div([h.Class(cn(styles, className)), h.DataAttribute("slot", slot)], children)

export const empty = part(emptyStyles, "empty")
export const emptyHeader = part(emptyHeaderStyles, "empty-header")
export const emptyTitle = part(cn(emptyTitleStyles, "font-prose"), "empty-title")
export const emptyDescription = part(cn(emptyDescriptionStyles, "font-prose"), "empty-description")
export const emptyContent = part(emptyContentStyles, "empty-content")

/** `EmptyMedia`; the `icon` variant stacks two tilted frames behind the icon tile. */
export const emptyMedia = <M>(
	h: HtmlBuilder<M>,
	options: { readonly variant?: "default" | "icon"; readonly className?: string },
	children: Children,
): Html => {
	const variant = options.variant ?? "default"
	const media = cn(emptyMediaVariants({ className: options.className, variant }))
	const stacked =
		variant === "icon"
			? [
					h.div([h.AriaHidden(true), h.Class(cn(media, emptyMediaStackLeftStyles))]),
					h.div([h.AriaHidden(true), h.Class(cn(media, emptyMediaStackRightStyles))]),
				]
			: []
	return h.div(
		[
			h.Class(cn(emptyMediaStyles, options.className)),
			h.DataAttribute("slot", "empty-media"),
			h.DataAttribute("variant", variant),
		],
		[...stacked, h.div([h.Class(media)], children)],
	)
}

/** The compact in-panel "nothing here" line; `dashed` frames it as a placeholder box. */
export const emptyMessage = <M>(
	h: HtmlBuilder<M>,
	options: { readonly dashed?: boolean; readonly className?: string },
	children: Children,
): Html =>
	h.div(
		[
			h.Class(
				cn(
					emptyMessageStyles,
					options.dashed === true && emptyMessageDashedStyles,
					options.className,
				),
			),
			h.DataAttribute("slot", "empty-message"),
		],
		children,
	)
