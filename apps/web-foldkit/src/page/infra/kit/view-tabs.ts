import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"

// `UnderlineTabStrip navigation` + `underlineTabClass` (common/underline-link-tabs.tsx), and the
// two section strips built on it: `HostsViewTabs` and `KubernetesViewTabs`.

export const underlineTabClass = (isActive: boolean): string =>
	cn(
		"-mb-px flex h-[34px] shrink-0 items-center gap-1.5 border-b-2 text-sm transition-colors",
		isActive
			? "border-primary font-medium text-foreground"
			: "border-transparent text-muted-foreground hover:text-foreground",
	)

export type TabLink = Readonly<{ id: string; title: string; href: string }>

/** A `<Link>` strip: TanStack marks the current one `active` with `data-status`. */
export const linkTabStrip = <M>(
	h: HtmlBuilder<M>,
	label: string,
	tabs: ReadonlyArray<TabLink>,
	activeId: string,
): Html =>
	h.nav(
		[
			h.AriaLabel(label),
			h.Class(cn("flex items-center gap-6 overflow-x-auto", "border-b", "-mx-4 -mb-4 px-4")),
		],
		tabs.map((tab) => {
			const isActive = tab.id === activeId
			return h.a(
				[
					h.Key(tab.id),
					h.Href(tab.href),
					...(isActive
						? [
								h.AriaCurrent("page"),
								h.DataAttribute("status", "active"),
								h.Class(cn(underlineTabClass(true), "active")),
							]
						: [h.Class(underlineTabClass(false))]),
				],
				[tab.title],
			)
		}),
	)

export type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** `pickTimeRangeSearch`: only the window travels between sibling views. */
export const pickTimeSearch = (search: TimeSearch): TimeSearch => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

export type HostsView = "hosts" | "containers"

export const hostsViewTabs = <M>(h: HtmlBuilder<M>, view: HostsView, search: TimeSearch): Html => {
	const window = pickTimeSearch(search)
	return linkTabStrip(
		h,
		"Hosts views",
		[
			{ id: "hosts", title: "Hosts", href: hrefOf(AppRoute.InfraHosts({ search: window })) },
			{
				id: "containers",
				title: "Containers",
				href: hrefOf(AppRoute.InfraContainers({ search: window })),
			},
		],
		view,
	)
}
