import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { pollTicks } from "../../../data/poll"
import type { PageSubscriptionInput } from "../../contract"
import { runningRuns } from "./derive"
import { Message, type Model } from "./model"

/** While a run is in progress the runs list is read again every 15 s, and stops once none is. */
const POLL = Duration.seconds(15)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	poll: entry(
		{ isRunning: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isRunning: runningRuns(model).length > 0 }),
			dependenciesToStream: ({ isRunning }) =>
				isRunning
					? pollTicks(POLL).pipe(
							Stream.mapEffect(() =>
								Effect.map(Clock.currentTimeMillis, (nowMs) => Message.TickedPoll({ nowMs })),
							),
						)
					: Stream.empty,
		},
	),
}))
