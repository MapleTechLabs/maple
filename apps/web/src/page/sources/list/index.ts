import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/sources`: every source the org sends from. */
export const page = definePage(
	"SourcesList",
	{ Model, Message },
	{
		routes: ["Sources"],
		init,
		update,
		view,
		breadcrumbs: () => [{ label: "Sources", isPageHeading: true }],
	},
)
