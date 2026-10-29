import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/anomalies`: one instance; a search change arrives as `routeChanged`. */
export const entry = definePage("AnomaliesList", { Model, Message }, { routes: ["Anomalies"] })

export const page = entry.lazy(() => import("./implementation"))
