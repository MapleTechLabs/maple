import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { icon, type IconName } from "../../../ui/icon"

// `SettingsNavShell`: the rail of `/settings`, `/account` and `/integrations`. Tabs are buttons, sibling
// pages are links.

export type NavShellRow<Id extends string> =
	| Readonly<{ kind: "tab"; id: Id; label: string; icon: IconName }>
	| Readonly<{ kind: "link"; id: string; label: string; icon: IconName; href: string }>

export type NavShellSection<Id extends string> = Readonly<{
	id: string
	title: string
	items: ReadonlyArray<NavShellRow<Id>>
}>

const rowClass = (isActive: boolean) =>
	cn(
		"group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors text-left",
		isActive
			? "bg-accent text-accent-foreground font-medium"
			: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
	)

const activeIndicator = <M>(h: HtmlBuilder<M>): Html =>
	h.span([h.AriaHidden(true), h.Class("absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary")], [])

const rowChildren = <M>(h: HtmlBuilder<M>, isActive: boolean, name: IconName, label: string) => [
	...(isActive ? [activeIndicator(h)] : []),
	icon(h, name, { size: 16, className: "shrink-0" }),
	label,
]

export const navShell = <M, Id extends string>(
	h: HtmlBuilder<M>,
	sections: ReadonlyArray<NavShellSection<Id>>,
	active: string,
	onSelectTab: (tab: Id) => M,
): Html =>
	h.nav(
		[h.Class("flex flex-col gap-5")],
		sections.map((section) =>
			h.div(
				[h.Key(section.id), h.Class("flex flex-col gap-1")],
				[
					eyebrow(h, { as: "div", className: "px-2.5" }, [section.title]),
					h.div(
						[h.Class("flex flex-col gap-0.5")],
						section.items.map((row) => {
							const isActive = row.id === active
							return row.kind === "link"
								? h.a(
										[
											h.Key(row.id),
											h.Href(row.href),
											// TanStack's active `<Link>`: `aria-current`, the `active` class and `data-status`.
											...(isActive
												? [
														h.AriaCurrent("page"),
														h.Class(`${rowClass(isActive)} active`),
														h.DataAttribute("status", "active"),
													]
												: [h.Class(rowClass(isActive))]),
										],
										rowChildren(h, isActive, row.icon, row.label),
									)
								: h.button(
										[
											h.Key(row.id),
											h.Class(rowClass(isActive)),
											h.Type("button"),
											h.OnClick(onSelectTab(row.id)),
										],
										rowChildren(h, isActive, row.icon, row.label),
									)
						}),
					),
				],
			),
		),
	)
