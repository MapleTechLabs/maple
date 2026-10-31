import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../code"

/** `/service-map`. One instance per org; search changes (window, environment, focus) arrive as `routeChanged`. */
export const entry = definePage("ServiceMap", { Model, Message }, { routes: ["ServiceMap"] })

export const page = entry.lazy(pageCode.ServiceMap)
