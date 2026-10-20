import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/**
 * `/share/$token`: a public page outside the shell. The root renders it bare and gives it a
 * context without a signed-in org (see `pageContextOf`); one instance per token.
 */
export const page = definePage(
	"Share",
	{ Model, Message },
	{
		routes: ["Share"],
		key: (route) => route.token,
		init: (route) => init(route),
		update: (model, message) => update(model, message),
		routeChanged: (model, route) => routeChanged(model, route),
		view,
		subscriptions,
		breadcrumbs: () => [],
	},
)
