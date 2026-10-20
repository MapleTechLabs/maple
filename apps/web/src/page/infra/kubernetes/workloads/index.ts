import { definePage } from "../../../contract"
import { kubernetesBreadcrumbs } from "../../kit/view-tabs"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/kubernetes/workloads`: the workloads of one kind. Search changes arrive as `routeChanged`. */
export const page = definePage(
	"InfraKubernetesWorkloads",
	{ Model, Message },
	{
		routes: ["InfraKubernetesWorkloads"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => kubernetesBreadcrumbs("workloads", model.search),
	},
)
