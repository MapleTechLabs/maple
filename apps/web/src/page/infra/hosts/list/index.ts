import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/hosts`: the host fleet. Search changes arrive as `routeChanged`. */
export const entry = definePage("InfraHosts", { Model, Message }, { routes: ["InfraHosts"] })

export const page = entry.lazy(() => import("./implementation"))
