import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/dashboards`: the org's dashboards. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("DashboardsList", { Model, Message }, { routes: ["Dashboards"] })

export const page = entry.lazy(pageCode.DashboardsList)
