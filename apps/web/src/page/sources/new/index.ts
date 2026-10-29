import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/sources/new`: one instance per visit; `?platform=` or `?integration=` moves between the steps. */
export const entry = definePage("SourcesNew", { Model, Message }, { routes: ["SourcesNew"] })

export const page = entry.lazy(() => import("./implementation"))
