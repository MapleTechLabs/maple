import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/alerts/uptime/new`: one instance per monitor being edited, or the new one. */
export const entry = definePage(
	"AlertsUptimeNew",
	{ Model, Message },
	{ routes: ["AlertsUptimeNew"], key: (route) => route.search.monitorId ?? "new" },
)

export const page = entry.lazy(pageCode.AlertsUptimeNew)
