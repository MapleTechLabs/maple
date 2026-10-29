import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/recommendations/$recommendationKey`: one instance per recommendation. */
export const entry = definePage(
	"Recommendation",
	{ Model, Message },
	{ routes: ["Recommendation"], key: (route) => route.recommendationKey },
)

export const page = entry.lazy(() => import("./implementation"))
