import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

/** `/replays/$sessionId`: one instance per session; `t` arrives as `routeChanged`. */
export const page = definePage(
	"ReplayDetail",
	{ Model, Message },
	{
		routes: ["Replay"],
		key: (route) => route.sessionId,
		init,
		preload,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs,
	},
)
