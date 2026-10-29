import { definePage } from "../../contract"
import { Message } from "./model"
import { Model } from "./model"

/** `/security/runs/$runId`: one instance per run. */
export const entry = definePage(
	"SecurityRun",
	{ Model, Message },
	{ routes: ["SecurityRun"], key: (route) => route.runId },
)

export const page = entry.lazy(() => import("./implementation"))
