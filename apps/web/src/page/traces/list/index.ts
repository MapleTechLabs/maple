import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/traces`: the trace list. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("TracesList", { Model, Message }, { routes: ["Traces"] })

export const page = entry.lazy(pageCode.TracesList)
