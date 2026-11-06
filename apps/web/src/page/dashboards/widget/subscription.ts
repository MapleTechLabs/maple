import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { documentStream } from "../kit/document-stream"
import { Message } from "./message"
import type { Model } from "./model"

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
	}),
)
