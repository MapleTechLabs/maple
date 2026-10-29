import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/kubernetes/pods`: the pod fleet. Search changes (and the peek) arrive as `routeChanged`. */
export const entry = definePage(
	"InfraKubernetesPods",
	{ Model, Message },
	{ routes: ["InfraKubernetesPods"] },
)

export const page = entry.lazy(() => import("./implementation"))
