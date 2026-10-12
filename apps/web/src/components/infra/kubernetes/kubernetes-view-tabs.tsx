import { Link } from "@tanstack/react-router"

import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import { KUBERNETES_VIEWS, type KubernetesView } from "./views"

/**
 * The section's spine: one strip of views where four sidebar rows used to be.
 *
 * Each tab is a real link, so the views keep their own URLs (and ⌘-click, and
 * the back button). Only the time window travels between them — a pod filter
 * means nothing on the nodes list, and carrying it would make the other view
 * silently narrower than it looks.
 */
export function KubernetesViewTabs({
	view,
	timeSearch,
}: {
	view: KubernetesView
	timeSearch: TimeRangeSearch
}) {
	return (
		<UnderlineTabStrip navigation label="Kubernetes views">
			{KUBERNETES_VIEWS.map((candidate) => (
				<Link
					key={candidate.id}
					to={candidate.href}
					search={timeSearch}
					aria-current={candidate.id === view ? "page" : undefined}
					className={underlineTabClass(candidate.id === view)}
				>
					{candidate.title}
				</Link>
			))}
		</UnderlineTabStrip>
	)
}
