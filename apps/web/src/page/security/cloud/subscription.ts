import { Clock, Duration, Effect, Stream } from "effect"
import { Subscription } from "foldkit"
import { pollTicks } from "../../../data/poll"
import type { PageSubscriptionInput } from "../../contract"
import { Message, type Model } from "./model"

/** The clock is read every minute, so the last-seen times move. */
const CLOCK = Duration.minutes(1)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	clock: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () =>
				pollTicks(CLOCK).pipe(
					Stream.mapEffect(() =>
						Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
					),
				),
		},
	),
}))
