import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

/** `/users/$userId`: one instance per user; the tab, namespace and window arrive as `routeChanged`. */
export const page = definePage(
	"UserDetail",
	{ Model, Message },
	{
		routes: ["UserDetail"],
		key: (route) => route.userId,
		init,
		preload,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs,
	},
)
