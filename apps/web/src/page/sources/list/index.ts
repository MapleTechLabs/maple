import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/sources`: every source the org sends from. */
export const entry = definePage("SourcesList", { Model, Message }, { routes: ["Sources"] })

export const page = entry.lazy(pageCode.SourcesList)
