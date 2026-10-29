import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/dashboards/$dashboardId/widgets/$widgetId`: one instance per widget. */
export const entry = definePage(
	"DashboardWidget",
	{ Model, Message },
	{ routes: ["DashboardWidget"], key: (route) => `${route.dashboardId}/${route.widgetId}` },
)

export const page = entry.lazy(() => import("./implementation"))
