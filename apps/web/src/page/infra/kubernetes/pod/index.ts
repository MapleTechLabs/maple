import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/kubernetes/pods/$podName`: one instance per pod name; the window and namespace arrive as `routeChanged`. */
export const entry = definePage(
	"InfraKubernetesPod",
	{ Model, Message },
	{ routes: ["InfraKubernetesPod"], key: (route) => route.podName },
)

export const page = entry.lazy(() => import("./implementation"))
