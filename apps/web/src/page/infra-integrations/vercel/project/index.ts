import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { titleOf, view } from "./view"

/** `/infra/vercel/$projectId`: one project's requests, errors, deployments and AI Gateway use. */
export const page = definePage(
	"InfraVercelProject",
	{ Model, Message },
	{
		routes: ["InfraVercelProject"],
		key: (route) => `InfraVercelProject:${route.projectId}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "Vercel", href: "/infra/vercel" },
			{ label: titleOf(model) },
		],
	},
)
