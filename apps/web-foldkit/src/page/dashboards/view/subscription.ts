import { Effect, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { rowToDocument } from "../../../data/collections/dashboards"
import { liveQueryStream } from "../../../data/live-query"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { dashboardsOf } from "../kit/store"
import { Message } from "./message"
import type { Model } from "./model"

/** `useDashboardsRead`'s `dashboards.find(id)`: the board's row, decoded, as the collection changes. */
const dashboard = (orgId: string, dashboardId: string) =>
	Stream.unwrap(
		Effect.map(dashboardsOf(orgId), (collection) =>
			liveQueryStream(
				(q) => q.from({ d: collection }),
				(rows) =>
					Message.UpdatedDashboard({
						orgId,
						maybeDocument: Option.flatMap(
							Option.fromNullishOr(rows.find((row) => row.id === dashboardId)),
							rowToDocument,
						),
					}),
			),
		),
	)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		dashboard: entry(
			{ orgId: Schema.String, dashboardId: Schema.String },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					dashboardId: model.dashboardId,
				}),
				dependenciesToStream: ({ orgId, dashboardId }) => dashboard(orgId, dashboardId),
			},
		),
	}),
)
