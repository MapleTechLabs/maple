import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { init, update } from "./update"
import { view } from "./view"

/**
 * `/security/dependencies`, in the Security frame: lockfile scans of the connected repositories,
 * so no code-audit plan gates it.
 */
export const page = definePage(
	"SecurityDependencies",
	{ Model, Message },
	{
		routes: ["SecurityDependencies"],
		key: () => "security-dependencies",
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: () => breadcrumbsOf("dependencies"),
	},
)
