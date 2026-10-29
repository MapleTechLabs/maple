import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/railway`: Railway services, or the connect card while no token is saved. */
export const entry = definePage("InfraRailway", { Model, Message }, { routes: ["InfraRailway"] })

export const page = entry.lazy(() => import("./implementation"))
