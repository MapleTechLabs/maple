import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { destinationRows } from "../shared/collections"
import { uptimeTabHref } from "../shared/uptime-commands"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	destinations: entry(
		{ orgId: Schema.String },
		{
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
		},
	),
}))

/** `/alerts/uptime/new`: one instance per monitor being edited, or the new one. */
export const page = definePage(
	"AlertsUptimeNew",
	{ Model, Message },
	{
		routes: ["AlertsUptimeNew"],
		key: (route) => route.search.monitorId ?? "new",
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: () => [
			{ label: "Alerts", href: "/alerts" },
			{ label: "Uptime", href: uptimeTabHref() },
		],
	},
)
