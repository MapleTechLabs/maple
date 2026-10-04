import { Link } from "@tanstack/react-router"

import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"

import { ServerIcon } from "@/components/icons"
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
		<div className="flex min-w-0 items-center gap-3">
			<ServerIcon size={18} className="shrink-0" />
			<Tabs value={view} className="min-w-0">
				<TabsList variant="underline" className="-mx-2 gap-x-1 py-0">
					{HOSTS_VIEWS.map((candidate) => (
						<TabsTrigger
							key={candidate.id}
							value={candidate.id}
							className="h-8 px-2 text-sm sm:h-8"
							nativeButton={false}
							render={<Link to={candidate.href} search={window} />}
						>
							{candidate.title}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
		</div>
	)
}
