import { definePage } from "../../../contract"
import { kubernetesBreadcrumbs } from "../../kit/view-tabs"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/kubernetes/pods`: the pod fleet. Search changes (and the peek) arrive as `routeChanged`. */
export const page = definePage(
	"InfraKubernetesPods",
	{ Model, Message },
	{
		routes: ["InfraKubernetesPods"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => kubernetesBreadcrumbs("pods", model.search),
	},
)
