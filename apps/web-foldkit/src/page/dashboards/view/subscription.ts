import { resolveRefreshIntervalSeconds } from "@maple/web/lib/dashboard-controls/search-params"
import { Duration, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { documentStream } from "../kit/document-stream"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./update"

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		dashboard: entry(
			{ orgId: Schema.String, dashboardId: Schema.String },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					dashboardId: model.dashboardId,
				}),
				dependenciesToStream: ({ orgId, dashboardId }) =>
					documentStream(orgId, dashboardId, (maybeDocument) =>
						Message.UpdatedDashboard({ orgId, maybeDocument }),
					),
			},
		),
		/** `useIntervalRefresh`: paused in edit mode, and a hidden tab skips its ticks. */
		autoRefresh: entry(
			{ seconds: Schema.Number },
			{
				modelToDependencies: ({ model }) => ({
					seconds:
						isEditing(model) || model.document === null
							? 0
							: resolveRefreshIntervalSeconds(
									model.search.refresh,
									model.document.refreshIntervalSeconds,
								),
				}),
				dependenciesToStream: ({ seconds }) =>
					seconds <= 0
						? Stream.empty
						: Stream.tick(Duration.seconds(seconds)).pipe(
								Stream.drop(1),
								Stream.filter(() => !document.hidden),
								Stream.map(() => Message.TickedAutoRefresh()),
							),
			},
		),
	}),
)
