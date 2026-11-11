import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/status-pages/$pageId/view`: the page as visitors see it, for members; an internal page's only home. */
export const page = definePage(
	"StatusPageView",
	{ Model, Message },
	{
		routes: ["StatusPageView"],
		key: (route) => route.pageId,
		init,
		update,
		view,
		breadcrumbs: breadcrumbsOf,
	},
)
