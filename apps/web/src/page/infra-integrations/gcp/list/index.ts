import { definePage } from "../../../contract"
import { Message } from "./model"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/gcp`: the Google Cloud workloads by view, and the resource inventory. */
export const entry = definePage("InfraGcp", { Model, Message }, { routes: ["InfraGcp"] })

export const page = entry.lazy(pageCode.InfraGcp)
