import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

/** `/infra/gcp`: the Google Cloud workloads by view, and the resource inventory. */
export const page = definePage(
	"InfraGcp",
	{ Model, Message },
	{
		routes: ["InfraGcp"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		source: () => platformSource("gcp"),
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Google Cloud" }],
	},
)
