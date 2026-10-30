import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/railway`: Railway services, or the connect card while no token is saved. */
export const entry = definePage("InfraRailway", { Model, Message }, { routes: ["InfraRailway"] })

export const page = entry.lazy(pageCode.InfraRailway)
