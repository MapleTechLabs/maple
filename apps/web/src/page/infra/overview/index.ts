import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra`: every source's health, what needs a look first. */
export const entry = definePage("InfraOverview", { Model, Message }, { routes: ["Infra"] })

export const page = entry.lazy(() => import("./implementation"))
