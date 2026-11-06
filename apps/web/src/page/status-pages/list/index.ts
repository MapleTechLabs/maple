import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/status-pages`: every status page of the org. */
export const page = definePage(
	"StatusPages",
	{ Model, Message },
	{
		routes: ["StatusPages"],
		init,
		update,
		view,
		breadcrumbs: () => [{ label: "Status pages", isPageHeading: true }],
	},
)
