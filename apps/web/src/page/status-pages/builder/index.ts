import { definePage } from "../../contract"
import { statusPagesHref } from "../shared/commands"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/status-pages/new`: set up with a coding agent or in the one-screen builder. */
export const page = definePage(
	"StatusPageNew",
	{ Model, Message },
	{
		routes: ["StatusPageNew"],
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: () => [
			{ label: "Status pages", href: statusPagesHref() },
			{ label: "New", isPageHeading: true },
		],
	},
)
