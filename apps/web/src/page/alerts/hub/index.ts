import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/alerts`: the incident-first hub (Inbox, Rules, Routing). One instance per org; tabs are search. */
export const entry = definePage("AlertsHub", { Model, Message }, { routes: ["Alerts"] })

export const page = entry.lazy(pageCode.AlertsHub)
