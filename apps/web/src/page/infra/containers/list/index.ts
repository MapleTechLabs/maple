import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/containers`: the container fleet. Search changes arrive as `routeChanged`. */
export const entry = definePage("InfraContainers", { Model, Message }, { routes: ["InfraContainers"] })

export const page = entry.lazy(pageCode.InfraContainers)
