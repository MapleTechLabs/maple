import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `UnderlineTabStrip` and `underlineTabClass`: a row of tabs with an underlined active tab.

export type UnderlineTabStripOptions = Readonly<{
	label: string
	/** Pulls the strip out of a `p-4` sticky header so the underline meets its bottom edge. */
	bleed?: boolean
	divided?: boolean
	/** A `<nav>` of links marking the current route with `aria-current`, not a tablist. */
	navigation?: boolean
	className?: string
}>

export const underlineTabStrip = <M>(
	h: HtmlBuilder<M>,
	options: UnderlineTabStripOptions,
	children: ReadonlyArray<Html>,
): Html => {
	const attributes = [
		...(options.navigation === true ? [] : [h.Role("tablist")]),
		h.AriaLabel(options.label),
		h.Class(
			cn(
				"flex items-center gap-6 overflow-x-auto",
				(options.divided ?? true) && "border-b",
				(options.bleed ?? true) ? "-mx-4 -mb-4 px-4" : "px-0",
				options.className,
			),
		),
	]
	return options.navigation === true ? h.nav(attributes, children) : h.div(attributes, children)
}

export const underlineTabClass = (isActive: boolean): string =>
	cn(
		"-mb-px flex h-[34px] shrink-0 items-center gap-1.5 border-b-2 text-sm transition-colors",
		isActive
			? "border-primary font-medium text-foreground"
			: "border-transparent text-muted-foreground hover:text-foreground",
	)

export type LinkTab = Readonly<{
	key: string
	href: string
	label: string
	/** The tab the page shows: underlined. */
	isCurrent: boolean
	/** The link matches the URL (path and search): `aria-current` and the router's `active`. */
	isRouteActive: boolean
}>

/** A page's tabs as links: each one a route, the current one underlined. */
export const linkTabStrip = <M>(h: HtmlBuilder<M>, label: string, tabs: ReadonlyArray<LinkTab>): Html =>
	underlineTabStrip(
		h,
		{
			navigation: true,
			label,
			bleed: false,
			divided: false,
			className: "gap-0 overflow-visible border-b border-border",
		},
		tabs.map((tab) =>
			h.a(
				[
					h.Key(tab.key),
					...(tab.isRouteActive ? [h.AriaCurrent("page")] : []),
					h.Class(
						cn(
							cn(
								underlineTabClass(tab.isCurrent),
								"h-9 px-3 first:pl-0.5",
							),
							tab.isRouteActive && "active",
						),
					),
					...(tab.isRouteActive ? [h.DataAttribute("status", "active")] : []),
					h.Href(tab.href),
				],
				[tab.label],
			),
		),
	)
