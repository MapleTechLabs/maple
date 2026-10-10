import { Link } from "@tanstack/react-router"

import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"
import { pickTimeRangeSearch, type TimeRangeSearch } from "@/components/time-range-picker/search"

export const HOSTS_VIEWS = [
	{ id: "hosts", title: "Hosts", href: "/infra/hosts" },
	{ id: "containers", title: "Containers", href: "/infra/containers" },
] as const

export type HostsView = (typeof HOSTS_VIEWS)[number]["id"]

/** Hosts and Containers are two views of one section, switched like the Kubernetes tabs. */
export function HostsViewTabs({ view, timeSearch }: { view: HostsView; timeSearch: TimeRangeSearch }) {
	const window = pickTimeRangeSearch(timeSearch)
	return (
		<UnderlineTabStrip navigation label="Hosts views">
			{HOSTS_VIEWS.map((candidate) => (
				<Link
					key={candidate.id}
					to={candidate.href}
					search={window}
					aria-current={candidate.id === view ? "page" : undefined}
					className={underlineTabClass(candidate.id === view)}
				>
					{candidate.title}
				</Link>
			))}
		</UnderlineTabStrip>
	)
}
