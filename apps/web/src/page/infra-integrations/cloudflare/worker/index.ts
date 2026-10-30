import { definePage } from "../../../contract"
import { Message } from "./model"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/cloudflare/workers/$scriptName`: one Worker; another script is another instance. */
export const entry = definePage(
	"InfraCloudflareWorker",
	{ Model, Message },
	{ routes: ["InfraCloudflareWorker"], key: (route) => `InfraCloudflareWorker:${route.scriptName}` },
)

export const page = entry.lazy(pageCode.InfraCloudflareWorker)
