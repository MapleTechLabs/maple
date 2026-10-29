import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/containers/$containerName`: one instance per container name; a window change arrives as `routeChanged`. */
export const entry = definePage(
	"InfraContainer",
	{ Model, Message },
	{ routes: ["InfraContainer"], key: (route) => route.containerName },
)

export const page = entry.lazy(() => import("./implementation"))
