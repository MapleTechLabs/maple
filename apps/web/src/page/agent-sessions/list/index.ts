import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/agent-sessions`: the sessions list. Search changes arrive as `routeChanged` and keep the window. */
export const entry = definePage("AgentSessionsList", { Model, Message }, { routes: ["AgentSessions"] })

export const page = entry.lazy(() => import("./implementation"))
