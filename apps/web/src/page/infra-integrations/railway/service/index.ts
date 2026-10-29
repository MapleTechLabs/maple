import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/railway/$serviceId`: one service's usage; a new service id is a new instance. */
export const entry = definePage(
	"InfraRailwayService",
	{ Model, Message },
	{ routes: ["InfraRailwayService"], key: (route) => `InfraRailwayService:${route.serviceId}` },
)

export const page = entry.lazy(() => import("./implementation"))
