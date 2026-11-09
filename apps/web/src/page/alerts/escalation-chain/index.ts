import { definePage } from "../../contract"
import { routingTabHref } from "../shared/escalation-chains"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, update } from "./update"
import { chainTitle, view } from "./view"

/** `/alerts/escalation-chains/new` and `/:chainId`: one instance per chain, or the new one. */
export const page = definePage(
	"AlertsEscalationChain",
	{ Model, Message },
	{
		routes: ["AlertsEscalationChainNew", "AlertsEscalationChain"],
		key: (route) => (route._tag === "AlertsEscalationChain" ? route.chainId : "new"),
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: (model) => [
			{ label: "Alerts", href: "/alerts" },
			{ label: "Routing", href: routingTabHref() },
			{ label: chainTitle(model) },
		],
	},
)
