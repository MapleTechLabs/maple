import { definePage } from "../../../contract"
import { kubernetesBreadcrumbs } from "../../kit/view-tabs"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { summarySource } from "../../../../shell/source-link"

/** `/infra/kubernetes/workloads/$kind/$workloadName`: one instance per workload; the window arrives as `routeChanged`. */
export const page = definePage(
	"InfraKubernetesWorkload",
	{ Model, Message },
	{
		routes: ["InfraKubernetesWorkload"],
		key: (route) => `${route.kind}/${route.workloadName}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		source: (model) => summarySource(model.summary.data),
		breadcrumbs: (model) =>
			kubernetesBreadcrumbs("workloads", model.search, [{ label: model.workloadName }]),
	},
)
