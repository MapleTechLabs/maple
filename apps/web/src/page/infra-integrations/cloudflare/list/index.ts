import { definePage } from "../../../contract"
import { Message } from "./model"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/cloudflare`: zones, Workers and queues, or why there are none yet. */
export const entry = definePage("InfraCloudflare", { Model, Message }, { routes: ["InfraCloudflare"] })

export const page = entry.lazy(pageCode.InfraCloudflare)
