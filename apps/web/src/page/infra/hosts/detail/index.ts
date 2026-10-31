import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/hosts/$hostName`: one instance per host; a window change arrives as `routeChanged`. */
export const entry = definePage(
	"InfraHost",
	{ Model, Message },
	{ routes: ["InfraHost"], key: (route) => route.hostName },
)

export const page = entry.lazy(pageCode.InfraHost)
