import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/integrations`: the hub, or one integration's page (`?integration=`). One instance for both. */
export const entry = definePage("Integrations", { Model, Message }, { routes: ["Integrations"] })

export const page = entry.lazy(() => import("./implementation"))
