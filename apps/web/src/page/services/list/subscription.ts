import { Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { incidentsLoadFailedStream, incidentsStream } from "../../kit/service-health"
import { Message } from "./message"
import type { Model } from "./model"
import { listKeys } from "../../kit/list-keys"
import { focusableServices } from "./update"

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		listKeys: entry(
			{ hasRows: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					hasRows: focusableServices(model, context).length > 0,
				}),
				dependenciesToStream: ({ hasRows }) =>
					hasRows
						? listKeys({ toMessage: (key) => Message.PressedListKey({ key }) })
						: Stream.empty,
			},
		),
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
