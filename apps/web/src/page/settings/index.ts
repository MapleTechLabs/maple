import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/settings`: one instance per org; a tab switch is a search change (`routeChanged`). */
export const entry = definePage("Settings", { Model, Message }, { routes: ["Settings"] })

export const page = entry.lazy(() => import("./implementation"))
