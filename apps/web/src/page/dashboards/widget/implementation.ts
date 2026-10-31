import { implementPage } from "../../contract"
import { entry } from "./index"
import { update } from "./page-update"
import { subscriptions } from "./subscription"
import { askToLeave, init, isBlockingNavigation, routeChanged, widgetOf } from "./update"
import { topbarActions, view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	view,
	topbarActions,
	subscriptions,
	isBlockingNavigation,
	blockedNavigation: (model, url) => askToLeave(model, url),
	breadcrumbs: (model) =>
		model.document !== null && widgetOf(model) !== null
			? [
					{ label: "Dashboards", href: "/dashboards" },
					{ label: model.document.name, href: `/dashboards/${model.dashboardId}` },
					{ label: "Configure widget" },
				]
			: [
					{ label: "Dashboards", href: "/dashboards" },
					{ label: model.status === "Loading" ? "Loading…" : "Not found" },
				],
})
