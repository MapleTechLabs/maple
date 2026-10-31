import { definePage } from "../../../contract"
import { Message } from "./model"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/planetscale`: the database fleet, or the connect prompt. */
export const entry = definePage("InfraPlanetscale", { Model, Message }, { routes: ["InfraPlanetscale"] })

export const page = entry.lazy(pageCode.InfraPlanetscale)
