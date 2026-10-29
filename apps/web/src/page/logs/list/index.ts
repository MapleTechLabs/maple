import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/logs`: the logs stream. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("LogsList", { Model, Message }, { routes: ["Logs"] })

export const page = entry.lazy(() => import("./implementation"))
