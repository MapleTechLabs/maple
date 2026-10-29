import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/releases`: one instance; a search change arrives as `routeChanged`. */
export const entry = definePage("ReleasesList", { Model, Message }, { routes: ["Releases"] })

export const page = entry.lazy(() => import("./implementation"))
