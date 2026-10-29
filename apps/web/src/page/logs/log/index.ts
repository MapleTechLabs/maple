import { definePage } from "../../contract"
import { Message } from "./model"
import { Model } from "./model"

/** `/logs/$logId`: one instance per log key, so picking another log mounts a fresh page. */
export const entry = definePage("Log", { Model, Message }, { routes: ["Log"], key: (route) => route.logId })

export const page = entry.lazy(() => import("./implementation"))
