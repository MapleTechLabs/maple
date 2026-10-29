import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/**
 * `/infra/kubernetes/services` and `/infra/kubernetes/services/$serviceName`: the service lens. One
 * instance spans both, so picking a service keeps the rail.
 */
export const entry = definePage(
	"InfraKubernetesServiceLens",
	{ Model, Message },
	{ routes: ["InfraKubernetesServices", "InfraKubernetesService"], key: () => "lens" },
)

export const page = entry.lazy(() => import("./implementation"))
