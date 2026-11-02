import { cn } from "@maple/ui/lib/utils"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// `NavRailRow`: a page's own nav rail row (the settings rail), with the app sidebar row's height,
// type, radius and flush 2px active lane. An `href` renders a router link, an `onClick` a tab button.

const rowClass = (isActive: boolean) =>
	cn(
		ROW_LANE,
		"group flex h-8 items-center gap-2 rounded-lg px-2 text-xs transition-colors text-left",
		isActive
			? "rounded-l-none bg-accent font-medium text-primary before:bg-primary"
			: "text-muted-foreground before:bg-transparent hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground",
	)

export type NavRailRowOptions<M> = Readonly<
	{ isActive: boolean; attributes?: ReadonlyArray<Attribute<M>> } & (
		| { href: string; onClick?: never }
		| { onClick: M; href?: never }
	)
>

export const navRailRow = <M>(
	h: HtmlBuilder<M>,
	options: NavRailRowOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const extra = options.attributes ?? []
	if (options.href !== undefined)
		return h.a(
			[
				...extra,
				h.Href(options.href),
				// TanStack's active `<Link>`: `aria-current`, the `active` class and `data-status`.
				...(options.isActive
					? [
							h.AriaCurrent("page"),
							h.Class(`${rowClass(true)} active`),
							h.DataAttribute("status", "active"),
						]
					: [h.Class(rowClass(false))]),
			],
			children,
		)
	return h.button(
		[...extra, h.Class(rowClass(options.isActive)), h.Type("button"), h.OnClick(options.onClick)],
		children,
	)
}
