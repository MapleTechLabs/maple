import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/services/$serviceName`: one instance per service; tab, environment and window changes are `routeChanged`. */
export const entry = definePage(
	"ServiceDetail",
	{ Model, Message },
	{ routes: ["Service"], key: (route) => route.serviceName },
)

export const page = entry.lazy(pageCode.ServiceDetail)
