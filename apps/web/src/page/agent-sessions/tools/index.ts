import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/agent-sessions/tools`: every tool the window's agents called. Search changes arrive as `routeChanged`. */
export const entry = definePage("AgentSessionTools", { Model, Message }, { routes: ["AgentSessionTools"] })

export const page = entry.lazy(() => import("./implementation"))
