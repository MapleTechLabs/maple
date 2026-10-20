import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/vercel`: Vercel projects or AI Gateway usage, or the connect prompt while not connected. */
export const page = definePage(
	"InfraVercel",
	{ Model, Message },
	{
		routes: ["InfraVercel"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Vercel" }],
	},
)
