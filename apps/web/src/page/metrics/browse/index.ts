import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/metrics`: the metric explorer. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("MetricsBrowse", { Model, Message }, { routes: ["Metrics"] })

export const page = entry.lazy(() => import("./implementation"))
