import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../code"

/** `/integrations`: the hub, or one integration's page (`?integration=`). One instance for both. */
export const entry = definePage("Integrations", { Model, Message }, { routes: ["Integrations"] })

export const page = entry.lazy(pageCode.Integrations)
