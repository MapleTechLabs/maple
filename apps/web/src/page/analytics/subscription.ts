import { Duration, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersOf } from "./requests"
import { pollTicks } from "../../data/poll"

/** `AnalyticsLiveBadge`'s poll: twice inside the server's 15s cache TTL. */
const POLL_SECONDS = 15

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		/** `useIntervalRefresh`: restarts when the filters (the badge's atom) change; paused while hidden or offline. */
		livePoll: entry(
			{ filters: Schema.String },
			{
				modelToDependencies: ({ model }) => ({ filters: JSON.stringify(filtersOf(model.search)) }),
				dependenciesToStream: () =>
					pollTicks(Duration.seconds(POLL_SECONDS)).pipe(
						Stream.map(() => Message.TickedLivePoll()),
					),
			},
		),
	}),
)
