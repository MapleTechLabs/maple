import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { collectionLoadFailed } from "../shared/collection-load"
import { destinationRows, incidentRows } from "../shared/collections"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

const byOrg = { orgId: Schema.String }

const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	destinations: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
	}),
	incidents: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
	}),
	/** A stopped or stalled incidents stream shows the failure in its panel, not a skeleton. */
	incidentsLoadFailed: entry(
		{ orgId: Schema.String, isWatching: Schema.Boolean },
		{
			modelToDependencies: ({ model, context }) => ({
				orgId: context.orgId,
				isWatching: model.incidents === null && !model.isIncidentsLoadFailed,
			}),
			dependenciesToStream: ({ orgId, isWatching }) =>
				isWatching
					? collectionLoadFailed(`alert_incidents:${orgId}`, () =>
							Message.FailedLoadIncidents({ orgId }),
						)
					: Stream.empty,
		},
	),
}))

/** `/alerts/slos/$sloId`: one instance per SLO. */
export const page = definePage(
	"AlertsSlo",
	{ Model, Message },
	{
		routes: ["AlertsSlo"],
		key: (route) => route.sloId,
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
