import { definePage } from "../../../contract"
import { kubernetesBreadcrumbs } from "../../kit/view-tabs"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/kubernetes/nodes`: the node fleet. Search changes arrive as `routeChanged`. */
export const page = definePage(
	"InfraKubernetesNodes",
	{ Model, Message },
	{
		routes: ["InfraKubernetesNodes"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => kubernetesBreadcrumbs("nodes", model.search),
	},
)
