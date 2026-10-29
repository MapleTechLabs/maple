import { definePage } from "../../../contract"
import { Message } from "./model"
import { Model } from "./model"

/** `/infra/cloudflare/$zoneName`: one zone's traffic, DNS and security; another zone is another instance. */
export const entry = definePage(
	"InfraCloudflareZone",
	{ Model, Message },
	{ routes: ["InfraCloudflareZone"], key: (route) => `InfraCloudflareZone:${route.zoneName}` },
)

export const page = entry.lazy(() => import("./implementation"))
