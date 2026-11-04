import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** The board's breadcrumb: its name, or what kept it from loading. */
export const boardBreadcrumbLabel = (model: Model): string =>
	model.status === "Loading"
		? "Loading…"
		: model.status === "Failed"
			? "Couldn't load"
			: model.document === null
				? "Not found"
				: model.document.name

/** `/dashboards/$dashboardId`: one instance per dashboard; `mode=edit` and view params are search. */
export const page = definePage(
	"DashboardView",
	{ Model, Message },
	{
		routes: ["Dashboard"],
		key: (route) => route.dashboardId,
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => [
			{ label: "Dashboards", href: "/dashboards" },
			{ label: boardBreadcrumbLabel(model) },
		],
	},
)
