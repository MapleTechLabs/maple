import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/sources/$sourceId`: one instance per source; a tab link is a `routeChanged`. */
export const entry = definePage(
	"SourceDetail",
	{ Model, Message },
	{ routes: ["Source"], key: (route) => route.sourceId },
)

export const page = entry.lazy(() => import("./implementation"))
