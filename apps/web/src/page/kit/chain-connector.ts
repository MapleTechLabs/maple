import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"

/**
 * The line between two cards of a vertical chain, with a + on it that adds a card
 * there. The + shows while the gap is hovered or holds focus, and always on a touch screen or
 * when `isPinned` (the last gap, so a mouse user can see that the chain takes another card).
 */
export const chainConnector = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		/** The + button's id (a focus target) and accessible name; `null` draws the line alone. */
		insert: Readonly<{ id: string; label: string; onClick: M; isPinned?: boolean }> | null
		attributes?: ReadonlyArray<Attribute<M>>
	}>,
): Html =>
	h.div(
		[h.Class("group/connector relative flex h-6 justify-center"), ...(options.attributes ?? [])],
		[
			h.div([h.Class("h-full w-px bg-border"), h.AriaHidden(true)], []),
			...(options.insert === null
				? []
				: [
						iconButton(
							h,
							{
								label: options.insert.label,
								variant: "outline",
								size: "icon-xs",
								className: cn(
									"absolute top-1/2 -translate-y-1/2",
									options.insert.isPinned !== true &&
										"opacity-0 group-hover/connector:opacity-100 group-active/connector:opacity-100 group-focus-within/connector:opacity-100 pointer-coarse:opacity-100",
								),
								attributes: [h.Id(options.insert.id), h.OnClick(options.insert.onClick)],
							},
							[icon(h, "PlusIcon")],
						),
					]),
		],
	)
