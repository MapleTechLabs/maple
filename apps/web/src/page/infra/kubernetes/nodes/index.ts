import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/kubernetes/nodes`: the node fleet. Search changes arrive as `routeChanged`. */
export const entry = definePage(
	"InfraKubernetesNodes",
	{ Model, Message },
	{ routes: ["InfraKubernetesNodes"] },
)

export const page = entry.lazy(pageCode.InfraKubernetesNodes)
