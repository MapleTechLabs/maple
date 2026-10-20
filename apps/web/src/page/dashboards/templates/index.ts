import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/dashboards/templates`: the gallery; the selected template rides in `?template=`. */
export const page = definePage(
	"DashboardTemplates",
	{ Model, Message },
	{
		routes: ["DashboardsTemplates"],
		init,
		update,
		routeChanged,
		view,
		breadcrumbs: () => [{ label: "Dashboards", href: "/dashboards" }, { label: "Templates" }],
	},
)
