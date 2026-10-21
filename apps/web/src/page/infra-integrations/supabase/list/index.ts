import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/supabase`: the organization's projects, or the connect on-ramp while none is connected. */
export const page = definePage(
	"InfraSupabase",
	{ Model, Message },
	{
		routes: ["InfraSupabase"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Supabase" }],
	},
)
