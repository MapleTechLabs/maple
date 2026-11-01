import { definePage } from "../../contract"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/security/code/findings/$targetId/$fingerprint`: one instance per finding. */
export const page = definePage(
	"SecurityFinding",
	{ Model, Message },
	{
		routes: ["SecurityFinding"],
		key: (route) => `${route.targetId}/${route.fingerprint}`,
		init,
		update,
		view,
		breadcrumbs: breadcrumbsOf,
	},
)
