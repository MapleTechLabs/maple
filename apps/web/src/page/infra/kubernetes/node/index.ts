import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/kubernetes/nodes/$nodeName`: one instance per node; a window change arrives as `routeChanged`. */
export const entry = definePage(
	"InfraKubernetesNode",
	{ Model, Message },
	{ routes: ["InfraKubernetesNode"], key: (route) => route.nodeName },
)

export const page = entry.lazy(() => import("./implementation"))
