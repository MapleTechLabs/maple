import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/railway`: Railway services, or the connect card while no token is saved. */
export const page = definePage(
	"InfraRailway",
	{ Model, Message },
	{
		routes: ["InfraRailway"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Railway" }],
	},
)
