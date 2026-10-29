import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/alerts/uptime/$monitorId`: one instance per monitor. */
export const entry = definePage(
	"AlertsUptimeMonitor",
	{ Model, Message },
	{ routes: ["AlertsUptimeMonitor"], key: (route) => route.monitorId },
)

export const page = entry.lazy(() => import("./implementation"))
