import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../../platform/resources"
import type { PageSubscriptionInput } from "../../../contract"
import { phaseOf, statusOf } from "./derive"
import { Message } from "./model"
import type { Model } from "./model"
import { pollTicks } from "../../../../data/poll"

/** `useCloudflareIngestPhase`'s poll, matched to the poller's own cadence. */
const INGEST_POLL = Duration.seconds(30)
/** `useLiveClock`: "synced 2m ago" ages while the page stays open. */
const CLOCK_TICK = Duration.minutes(1)

const isSettling = (model: Model): boolean => {
	const phase = phaseOf(model)
	return phase !== null && phase.kind !== "live"
}

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		ingestPoll: entry(
			{ isSettling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isSettling: isSettling(model) }),
				dependenciesToStream: ({ isSettling: settling }) =>
					settling
						? Stream.map(pollTicks(INGEST_POLL), () => Message.TickedIngestPoll())
						: Stream.empty,
			},
		),
		liveClock: entry(
			{ isConnected: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isConnected: statusOf(model)?.connected === true }),
				dependenciesToStream: ({ isConnected }) =>
					isConnected
						? Stream.fromEffectRepeat(
								Effect.andThen(Effect.sleep(CLOCK_TICK), () =>
									Effect.map(Clock.currentTimeMillis, (nowMs) =>
										Message.TickedClock({ nowMs }),
									),
								),
							)
						: Stream.empty,
			},
		),
	}),
)
