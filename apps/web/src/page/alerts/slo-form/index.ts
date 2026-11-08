import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { destinationRows } from "../shared/collections"
import { slosTabHref } from "../shared/slo-commands"
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

/** `/alerts/slos/new`: one instance per SLO being edited, or the new one. */
export const page = definePage(
	"AlertsSloNew",
	{ Model, Message },
	{
		routes: ["AlertsSloNew"],
		key: (route) => route.search.sloId ?? "new",
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: () => [
			{ label: "Alerts", href: "/alerts" },
			{ label: "SLOs", href: slosTabHref() },
		],
	},
)
