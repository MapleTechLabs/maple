import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { destinationRows } from "../../kit/alert-collections"
import { detectionFormCrumbs } from "../kit/layout"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

// The org's alert destinations, live: the same rows the SLO and uptime editors pick from.
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

/** `/security/detections/new`: one instance per detection being edited, or the new one. */
export const page = definePage(
	"SecurityDetectionNew",
	{ Model, Message },
	{
		routes: ["SecurityDetectionNew"],
		key: (route) => route.search.detectionId ?? "new",
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: () => detectionFormCrumbs(),
	},
)
