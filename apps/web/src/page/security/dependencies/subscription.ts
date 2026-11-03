import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { pollTicks } from "../../../data/poll"
import type { PageSubscriptionInput } from "../../contract"
import { Message, type Model } from "./model"

/** While a scan someone asked for is pending, the repositories are read every 5 s. */
const SCAN_POLL = Duration.seconds(5)
/** The clock is read every minute, so the last-scan times move. */
const CLOCK = Duration.minutes(1)

const clockTicks = <A>(every: Duration.Input, toMessage: (nowMs: number) => A) =>
	pollTicks(every).pipe(Stream.mapEffect(() => Effect.map(Clock.currentTimeMillis, toMessage)))

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	scanPoll: entry(
		{ isPending: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isPending: model.pendingScans.length > 0 }),
			dependenciesToStream: ({ isPending }) =>
				isPending
					? clockTicks(SCAN_POLL, (nowMs) => Message.TickedScanPoll({ nowMs }))
					: Stream.empty,
		},
	),
	clock: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => clockTicks(CLOCK, (nowMs) => Message.ReadClock({ nowMs })),
		},
	),
}))
