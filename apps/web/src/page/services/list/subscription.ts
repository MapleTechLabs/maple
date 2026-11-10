import { Schema } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { incidentsLoadFailedStream, incidentsStream } from "../../kit/service-health"
import { Message } from "./message"
import type { Model } from "./model"

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		incidents: entry(
			{ orgId: Schema.String },
			{
				modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
				dependenciesToStream: ({ orgId }) =>
					incidentsStream(orgId, (incidents) => Message.UpdatedIncidents({ orgId, incidents })),
			},
		),
		incidentsLoadFailed: entry(
			{ orgId: Schema.String, isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isWaiting: AsyncData.isLoading(model.incidents),
				}),
				dependenciesToStream: ({ orgId, isWaiting }) =>
					incidentsLoadFailedStream(orgId, isWaiting, () => Message.FailedLoadIncidents({ orgId })),
			},
		),
	}),
)
