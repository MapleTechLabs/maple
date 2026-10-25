import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/releases`: one instance; a search change arrives as `routeChanged`. */
export const page = definePage(
	"ReleasesList",
	{ Model, Message },
	{
		routes: ["Releases"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Releases" }],
	},
)
