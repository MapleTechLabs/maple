import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { summarySource } from "../../../../shell/source-link"

/** `/infra/containers/$containerName`: one instance per container name; a window change arrives as `routeChanged`. */
export const page = definePage(
	"InfraContainer",
	{ Model, Message },
	{
		routes: ["InfraContainer"],
		key: (route) => route.containerName,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		source: (model) => summarySource(model.summary.data),
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "Containers", href: "/infra/containers" },
			{ label: model.containerName },
		],
	},
)
