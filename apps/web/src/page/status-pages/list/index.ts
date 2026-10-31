import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/status-pages`: every status page of the org. */
export const entry = definePage("StatusPages", { Model, Message }, { routes: ["StatusPages"] })

export const page = entry.lazy(pageCode.StatusPages)
