import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { icon, type IconName } from "../../../ui/icon"
import { navRailRow } from "../../../ui/nav-rail-row"

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

const rowChildren = <M>(h: HtmlBuilder<M>, name: IconName, label: string) => [
	icon(h, name, { size: 16, className: "shrink-0" }),
	h.span([h.Class("truncate")], [label]),
]

export const navShell = <M, Id extends string>(
	h: HtmlBuilder<M>,
	sections: ReadonlyArray<NavShellSection<Id>>,
	active: string,
	onSelectTab: (tab: Id) => M,
	ariaLabel?: string,
): Html =>
	h.nav(
		[h.Class("flex flex-col gap-5"), ...(ariaLabel === undefined ? [] : [h.AriaLabel(ariaLabel)])],
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
								? navRailRow(
										h,
										{ isActive, href: row.href, attributes: [h.Key(row.id)] },
										rowChildren(h, row.icon, row.label),
									)
								: navRailRow(
										h,
										{ isActive, onClick: onSelectTab(row.id), attributes: [h.Key(row.id)] },
										rowChildren(h, row.icon, row.label),
									)
						}),
					),
				],
			),
		),
	)
