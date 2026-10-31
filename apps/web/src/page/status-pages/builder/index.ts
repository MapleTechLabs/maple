import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/status-pages/new`: the one-screen builder. */
export const entry = definePage("StatusPageNew", { Model, Message }, { routes: ["StatusPageNew"] })

export const page = entry.lazy(pageCode.StatusPageNew)
