import { implementPage } from "../../contract"
import { entry } from "./index"
import { contextChanged, init, routeChanged, update } from "./update"
import { subscriptions } from "./subscription"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs: (model) => [
		{ label: "Agent Sessions", href: "/agent-sessions" },
		{ label: "Tools", href: "/agent-sessions/tools" },
		{ label: model.toolName },
	],
})
