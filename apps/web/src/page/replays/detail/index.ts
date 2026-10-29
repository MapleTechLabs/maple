import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/replays/$sessionId`: one instance per session; `t` arrives as `routeChanged`. */
export const entry = definePage(
	"ReplayDetail",
	{ Model, Message },
	{ routes: ["Replay"], key: (route) => route.sessionId },
)

export const page = entry.lazy(() => import("./implementation"))
