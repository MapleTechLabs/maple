import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { view } from "./view"

/** `/replays`: session replays. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"ReplaysList",
	{ Model, Message },
	{
		routes: ["Replays"],
		init,
		preload,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Replays", isPageHeading: true }],
	},
)
