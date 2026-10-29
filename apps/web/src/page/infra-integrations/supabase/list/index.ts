import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/supabase`: the organization's projects, or the connect on-ramp while none is connected. */
export const entry = definePage("InfraSupabase", { Model, Message }, { routes: ["InfraSupabase"] })

export const page = entry.lazy(() => import("./implementation"))
