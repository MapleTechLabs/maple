import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/service-map`. One instance per org; search changes (window, environment, focus) arrive as `routeChanged`. */
export const page = definePage(
	"ServiceMap",
	{ Model, Message },
	{
		routes: ["ServiceMap"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Service Map" }],
	},
)
