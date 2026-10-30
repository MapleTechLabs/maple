import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/services`: the services list. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("ServicesList", { Model, Message }, { routes: ["Services"] })

export const page = entry.lazy(pageCode.ServicesList)
