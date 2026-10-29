import { implementPage } from "../../../contract"
import { entry } from "./index"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	source: () => platformSource("cloudflare"),
	breadcrumbs: (model) => [
		{ label: "Infrastructure", href: "/infra" },
		{ label: "Cloudflare", href: "/infra/cloudflare?view=workers" },
		{ label: model.scriptName },
	],
})
