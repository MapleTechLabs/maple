import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/aws`: the connected accounts' streamed resources, or the on-ramp while none sends any. */
export const page = definePage(
	"InfraAws",
	{ Model, Message },
	{
		routes: ["InfraAws"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "AWS" }],
	},
)
