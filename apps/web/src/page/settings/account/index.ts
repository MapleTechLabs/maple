import { definePage } from "../../contract"
import { Message } from "./model"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/account`: one instance; a tab switch is a search change (`routeChanged`). */
export const entry = definePage("Account", { Model, Message }, { routes: ["Account"] })

export const page = entry.lazy(pageCode.Account)
