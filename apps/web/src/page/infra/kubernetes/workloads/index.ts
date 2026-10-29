import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/kubernetes/workloads`: the workloads of one kind. Search changes arrive as `routeChanged`. */
export const entry = definePage(
	"InfraKubernetesWorkloads",
	{ Model, Message },
	{ routes: ["InfraKubernetesWorkloads"] },
)

export const page = entry.lazy(() => import("./implementation"))
