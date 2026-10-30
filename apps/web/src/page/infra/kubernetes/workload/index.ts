import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/kubernetes/workloads/$kind/$workloadName`: one instance per workload; the window arrives as `routeChanged`. */
export const entry = definePage(
	"InfraKubernetesWorkload",
	{ Model, Message },
	{ routes: ["InfraKubernetesWorkload"], key: (route) => `${route.kind}/${route.workloadName}` },
)

export const page = entry.lazy(pageCode.InfraKubernetesWorkload)
