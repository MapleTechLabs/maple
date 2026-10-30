import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/traces/$traceId`: one instance per trace; `spanId`, `view` and `t` arrive as `routeChanged`. */
export const entry = definePage(
	"TraceDetail",
	{ Model, Message },
	{ routes: ["Trace"], key: (route) => route.traceId },
)

export const page = entry.lazy(pageCode.TraceDetail)
