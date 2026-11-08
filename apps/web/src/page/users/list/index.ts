import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { view } from "./view"

/** `/users`: the end users the SDKs identified. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"UsersList",
	{ Model, Message },
	{
		routes: ["Users"],
		init,
		preload,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Users", isPageHeading: true }],
	},
)
