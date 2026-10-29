import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/alerts/$ruleId`: one instance per rule; the tab and window are search. */
export const entry = definePage(
	"AlertRule",
	{ Model, Message },
	{ routes: ["AlertRule"], key: (route) => route.ruleId },
)

export const page = entry.lazy(() => import("./implementation"))
