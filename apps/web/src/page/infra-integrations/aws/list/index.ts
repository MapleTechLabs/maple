import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/aws`: the connected accounts' streamed resources, or the on-ramp while none sends any. */
export const entry = definePage("InfraAws", { Model, Message }, { routes: ["InfraAws"] })

export const page = entry.lazy(pageCode.InfraAws)
