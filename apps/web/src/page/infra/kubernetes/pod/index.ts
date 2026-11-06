import { definePage } from "../../../contract"
import { kubernetesBreadcrumbs } from "../../kit/view-tabs"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { summarySource } from "../../../../shell/source-link"

/** `/infra/kubernetes/pods/$podName`: one instance per pod name; the window and namespace arrive as `routeChanged`. */
export const page = definePage(
	"InfraKubernetesPod",
	{ Model, Message },
	{
		routes: ["InfraKubernetesPod"],
		key: (route) => route.podName,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		source: (model) => summarySource(model.summary.data),
		breadcrumbs: (model) => kubernetesBreadcrumbs("pods", model.search, [{ label: model.podName }]),
	},
)
