import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../code"

/** `/`: the Overview home page. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("Overview", { Model, Message }, { routes: ["Home"] })

export const page = entry.lazy(pageCode.Overview)
