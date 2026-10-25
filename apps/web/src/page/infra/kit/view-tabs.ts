import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { TimeSearch } from "../../kit/time-controls"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"

// The link strip on `UnderlineTabStrip navigation` and the two section strips built on it:
// `HostsViewTabs` and `KubernetesViewTabs`.

/** `onClick` handles a plain click in place of the router; the href still serves new tabs. */
export type TabLink<M = never> = Readonly<{
	id: string
	title: string
	href: string
	onClick?: M | undefined
}>

/** A `<Link>` strip: TanStack marks the current one `active` with `data-status`. */
export const linkTabStrip = <M>(
	h: HtmlBuilder<M>,
	label: string,
	tabs: ReadonlyArray<TabLink<M>>,
	activeId: string,
	/** Off when the strip sits in page flow rather than a header's `tabs` slot. */
	bleed = true,
): Html =>
	underlineTabStrip(
		h,
		{ label, navigation: true, bleed },
		tabs.map((tab) => {
			const isActive = tab.id === activeId
			return h.a(
				[
					h.Key(tab.id),
					h.Href(tab.href),
					...(tab.onClick === undefined
						? []
						: [h.OnClick(tab.onClick, { defaultAction: "Prevent" })]),
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

export type { TimeSearch }

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

export type KubernetesView = "pods" | "workloads" | "nodes" | "services"

/** `KUBERNETES_VIEWS` (components/infra/kubernetes/views.ts), with the window carried. */
const kubernetesViews = (search: TimeSearch): ReadonlyArray<TabLink> => {
	const window = pickTimeSearch(search)
	return [
		{ id: "pods", title: "Pods", href: hrefOf(AppRoute.InfraKubernetesPods({ search: window })) },
		{
			id: "workloads",
			title: "Workloads",
			href: hrefOf(AppRoute.InfraKubernetesWorkloads({ search: window })),
		},
		{ id: "nodes", title: "Nodes", href: hrefOf(AppRoute.InfraKubernetesNodes({ search: window })) },
		{
			id: "services",
			title: "Services",
			href: hrefOf(AppRoute.InfraKubernetesServices({ search: window })),
		},
	]
}

/** `KubernetesViewTabs`. */
export const kubernetesViewTabs = <M>(h: HtmlBuilder<M>, view: KubernetesView, search: TimeSearch): Html =>
	linkTabStrip(h, "Kubernetes views", kubernetesViews(search), view)

/** `KubernetesShell`'s breadcrumbs: the view crumb links back to its list once a trail follows. */
export const kubernetesBreadcrumbs = (
	view: KubernetesView,
	search: TimeSearch,
	trail: ReadonlyArray<Readonly<{ label: string; href?: string }>> = [],
): ReadonlyArray<Readonly<{ label: string; href?: string }>> => {
	const current = kubernetesViews(search).find((candidate) => candidate.id === view)
	const title = current?.title ?? ""
	return [
		{ label: "Infrastructure", href: "/infra" },
		{ label: "Kubernetes", href: hrefOf(AppRoute.InfraKubernetes({ search: pickTimeSearch(search) })) },
		trail.length > 0 && current !== undefined ? { label: title, href: current.href } : { label: title },
		...trail,
	]
}
