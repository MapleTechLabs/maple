import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/dashboards/$dashboardId`: one instance per dashboard; `mode=edit` and view params are search. */
export const entry = definePage(
	"DashboardView",
	{ Model, Message },
	{ routes: ["Dashboard"], key: (route) => route.dashboardId },
)

export const page = entry.lazy(pageCode.DashboardView)
