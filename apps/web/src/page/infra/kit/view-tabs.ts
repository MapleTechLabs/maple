import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { TimeSearch } from "../../kit/time-controls"
import { linkTabStrip } from "../../kit/underline-tabs"

// `HostsViewTabs` and `KubernetesViewTabs`, on the kit's `linkTabStrip`.

/** `onClick` handles a plain click in place of the router; the href still serves new tabs. */
export type TabLink<M = never> = Readonly<{
	id: string
	title: string
	href: string
	onClick?: M | undefined
}>

/** Maps `TabLink`s onto the kit strip; the infra-integrations list pages still call it this way. */
export const viewTabStrip = <M>(
	h: HtmlBuilder<M>,
	label: string,
	tabs: ReadonlyArray<TabLink<M>>,
	activeId: string,
): Html =>
	linkTabStrip(
		h,
		label,
		tabs.map((tab) => ({
			key: tab.id,
			href: tab.href,
			label: tab.title,
			onClick: tab.onClick,
			isCurrent: tab.id === activeId,
			isRouteActive: tab.id === activeId,
		})),
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
	return viewTabStrip(
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
	viewTabStrip(h, "Kubernetes views", kubernetesViews(search), view)

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
