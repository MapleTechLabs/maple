import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { subscriptions } from "./subscription"
import { view } from "./view"

/** `/traces`: the trace list. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"TracesList",
	{ Model, Message },
	{
		routes: ["Traces"],
		init,
		preload,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Traces", isPageHeading: true }],
	},
)
