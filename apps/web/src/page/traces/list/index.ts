import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/traces`: the trace list. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("TracesList", { Model, Message }, { routes: ["Traces"] })

export const page = entry.lazy(() => import("./implementation"))
