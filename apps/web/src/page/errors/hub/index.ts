import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/errors`: the issues list. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("ErrorsHub", { Model, Message }, { routes: ["Errors"] })

export const page = entry.lazy(pageCode.ErrorsHub)
