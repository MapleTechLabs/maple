import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/investigations`: one instance; a search change arrives as `routeChanged`. */
export const page = definePage(
	"InvestigationsList",
	{ Model, Message },
	{
		routes: ["Investigations"],
		init,
		update,
		routeChanged,
		view,
		breadcrumbs: () => [{ label: "Investigations" }],
	},
)
