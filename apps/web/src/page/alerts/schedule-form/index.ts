import { definePage } from "../../contract"
import { oncallTabHref } from "../shared/oncall-schedules"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/alerts/schedules/new`: one instance per schedule being edited, or the new one. */
export const page = definePage(
	"AlertsScheduleNew",
	{ Model, Message },
	{
		routes: ["AlertsScheduleNew"],
		key: (route) => route.search.scheduleId ?? "new",
		init,
		update,
		view,
		breadcrumbs: () => [
			{ label: "Alerts", href: "/alerts" },
			{ label: "On-call", href: oncallTabHref() },
		],
	},
)
