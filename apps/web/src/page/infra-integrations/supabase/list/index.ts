import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

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
		source: () => platformSource("supabase"),
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Supabase" }],
	},
)
