import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/dashboards/templates`: the gallery; the selected template rides in `?template=`. */
export const entry = definePage("DashboardTemplates", { Model, Message }, { routes: ["DashboardsTemplates"] })

export const page = entry.lazy(() => import("./implementation"))
