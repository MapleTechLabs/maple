import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/replays`: session replays. One instance per org; search changes arrive as `routeChanged`. */
export const entry = definePage("ReplaysList", { Model, Message }, { routes: ["Replays"] })

export const page = entry.lazy(pageCode.ReplaysList)
