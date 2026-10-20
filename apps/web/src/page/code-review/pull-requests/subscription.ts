import { Duration, Option, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { Message, type Model } from "./model"

/** `POLL_MS`: how often the list refetches while a review is queued or running. */
const POLL = Duration.seconds(5)

const isActive = (model: Model) =>
	Option.match(AsyncData.getData(model.reviews.data), {
		onNone: () => false,
		onSome: (response) =>
			response.reviews.some((review) => review.status === "queued" || review.status === "running"),
	})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	/** `useIntervalRefresh(refresh, { intervalMs: POLL_MS, enabled: active })`. */
	poll: entry(
		{ isActive: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isActive: isActive(model) }),
			dependenciesToStream: ({ isActive: active }) =>
				active
					? Stream.tick(POLL).pipe(
							Stream.drop(1),
							Stream.map(() => Message.TickedPoll()),
						)
					: Stream.empty,
		},
	),
}))
