import { cn } from "@maple/ui/lib/utils"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
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

// The app sidebar's row beside it: same height, type, radius and flush 2px active lane.
const rowClass = (isActive: boolean) =>
	cn(
		ROW_LANE,
		"group flex h-8 items-center gap-2 rounded-lg px-2 text-xs transition-colors text-left",
		isActive
			? "rounded-l-none bg-accent font-medium text-primary before:bg-primary"
			: "text-muted-foreground before:bg-transparent hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground",
	)

const rowChildren = <M>(h: HtmlBuilder<M>, name: IconName, label: string) => [
	icon(h, name, { size: 16, className: "shrink-0" }),
	h.span([h.Class("truncate")], [label]),
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
					eyebrow(h, { as: "div", className: "flex h-6 items-center px-2" }, [section.title]),
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
										rowChildren(h, row.icon, row.label),
									)
								: h.button(
										[
											h.Key(row.id),
											h.Class(rowClass(isActive)),
											h.Type("button"),
											h.OnClick(onSelectTab(row.id)),
										],
										rowChildren(h, row.icon, row.label),
									)
						}),
					),
				],
			),
		),
	)
