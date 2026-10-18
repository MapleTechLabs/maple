import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/services/$serviceName`: one instance per service; tab, environment and window changes are `routeChanged`. */
export const page = definePage(
	"ServiceDetail",
	{ Model, Message },
	{
		routes: ["Service"],
		key: (route) => route.serviceName,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => [{ label: "Services", href: "/services" }, { label: model.serviceName }],
	},
)
