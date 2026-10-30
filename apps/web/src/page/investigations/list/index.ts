import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/investigations`: one instance; a search change arrives as `routeChanged`. */
export const entry = definePage("InvestigationsList", { Model, Message }, { routes: ["Investigations"] })

export const page = entry.lazy(pageCode.InvestigationsList)
