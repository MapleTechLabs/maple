import { Duration, Option, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { Resources } from "../../../../platform/resources"
import type { PageSubscriptionInput } from "../../../contract"
import { unsyncedEnvironments } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { pollTicks } from "../../../../data/poll"

/** Re-reads while the page is empty, so a just-connected account fills in without a reload. */
const EMPTY_REFRESH = Duration.seconds(15)

const isEmpty = (model: Model): boolean =>
	AsyncData.isSuccess(model.services.data) && model.services.data.data.length === 0

const isSyncing = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => false,
		onSome: (status) => !status.authFailed && unsyncedEnvironments(status.environments) > 0,
	})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		emptyRefresh: entry(
			{ isEmpty: Schema.Boolean, includeStatus: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({
					isEmpty: isEmpty(model),
					includeStatus: isEmpty(model) && isSyncing(model),
				}),
				dependenciesToStream: ({ isEmpty: empty, includeStatus }) =>
					empty
						? Stream.map(pollTicks(EMPTY_REFRESH), () => Message.TickedEmptyRefresh({ includeStatus }))
						: Stream.empty,
			},
		),
	}),
)
