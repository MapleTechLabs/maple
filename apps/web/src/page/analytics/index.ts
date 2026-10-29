import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/analytics`: web analytics. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("Analytics", { Model, Message }, { routes: ["Analytics"] })

export const page = entry.lazy(() => import("./implementation"))
