import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { titleOf, view } from "./view"
import { platformSource } from "../../../../shell/source-link"

/** `/infra/supabase/$projectRef`: one project's charts; a new ref is a new instance. */
export const page = definePage(
	"InfraSupabaseProject",
	{ Model, Message },
	{
		routes: ["InfraSupabaseProject"],
		key: (route) => `InfraSupabaseProject:${route.projectRef}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		source: () => platformSource("supabase"),
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "Supabase", href: "/infra/supabase" },
			{ label: titleOf(model) },
		],
	},
)
