import { definePage } from "../../../contract"
import { Message } from "./model"
import { Model } from "./model"

/** `/infra/gcp/$service/$name`: one workload, or a Cloud SQL instance; each is its own instance. */
export const entry = definePage(
	"InfraGcpResource",
	{ Model, Message },
	{ routes: ["InfraGcpResource"], key: (route) => `InfraGcpResource:${route.service}:${route.name}` },
)

export const page = entry.lazy(() => import("./implementation"))
