import { Duration, Option, Schema, Stream, Array as Arr } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { Message, type Model } from "./model"
import { pollTicks } from "../../../data/poll"

/** How often the list refetches while a review is queued or running. */
const POLL = Duration.seconds(5)

const isActive = (model: Model) =>
	Option.match(AsyncData.getData(model.reviews.data), {
		onNone: () => false,
		onSome: (response) =>
			Arr.some(response.reviews, (review) => review.status === "queued" || review.status === "running"),
	})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	poll: entry(
		{ isActive: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isActive: isActive(model) }),
			dependenciesToStream: ({ isActive: active }) =>
				active ? pollTicks(POLL).pipe(Stream.map(() => Message.TickedPoll())) : Stream.empty,
		},
	),
}))
