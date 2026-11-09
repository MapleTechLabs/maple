import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon, type IconName } from "@maple/views/ui/icon"
import { navRailRow } from "@maple/views/ui/nav-rail-row"
import { vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { typography } from "@maple/views/ui/typography"

// `NavShell`: a page's own nav rail of titled sections (settings, security, alerts). Tabs are buttons,
// links go to sibling pages or search-param sections.

/** A row's trailing count; `error` for one that needs attention (open incidents). */
export type NavShellCount = Readonly<{ value: number; tone?: "muted" | "error" }>

type RowBase = Readonly<{ label: string; icon: IconName; count?: NavShellCount }>

export type NavShellRow<Id extends string> =
	| (RowBase & Readonly<{ kind: "tab"; id: Id }>)
	| (RowBase & Readonly<{ kind: "link"; id: string; href: string }>)

export type NavShellSection<Id extends string> = Readonly<{
	id: string
	title: string
	items: ReadonlyArray<NavShellRow<Id>>
}>

const rowChildren = <M>(h: HtmlBuilder<M>, row: RowBase) => [
	icon(h, row.icon, { size: 16, className: "shrink-0" }),
	typography(h, { truncate: true, className: "flex-1" }, [row.label]),
	...(row.count === undefined
		? []
		: [
				typography(
					h,
					{
						size: "xs",
						mono: true,
						numeric: true,
						tone: row.count.tone ?? "muted",
						className: "shrink-0",
					},
					[String(row.count.value)],
				),
			]),
]

export const navShell = <M, Id extends string>(
	h: HtmlBuilder<M>,
	sections: ReadonlyArray<NavShellSection<Id>>,
	active: string,
	onSelectTab: (tab: Id) => M,
	ariaLabel?: string,
): Html =>
	h.nav(
		[h.Class(vstackClass({ gap: "5" })), ...(ariaLabel === undefined ? [] : [h.AriaLabel(ariaLabel)])],
		Arr.map(sections, (section) =>
			vstack(h, { gap: "1", attributes: [h.Key(section.id)] }, [
				eyebrow(h, { as: "div", className: "flex h-6 items-center px-2" }, [section.title]),
				vstack(
					h,
					{ gap: "0.5" },
					Arr.map(section.items, (row) => {
						const isActive = row.id === active
						return row.kind === "link"
							? navRailRow(
									h,
									{ isActive, href: row.href, attributes: [h.Key(row.id)] },
									rowChildren(h, row),
								)
							: navRailRow(
									h,
									{ isActive, onClick: onSelectTab(row.id), attributes: [h.Key(row.id)] },
									rowChildren(h, row),
								)
					}),
				),
			]),
		),
	)
