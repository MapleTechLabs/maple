import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/alerts/create`: a new rule, a template, a chart's prefill, or `?ruleId=` to edit one. */
export const entry = definePage(
	"AlertEditor",
	{ Model, Message },
	{
		routes: ["AlertsCreate"],
		// A different rule or prefill source is a different draft (`RuleDraft.key` remounts the surface).
		key: (route) => JSON.stringify(route.search),
	},
)

export const page = entry.lazy(() => import("./implementation"))
