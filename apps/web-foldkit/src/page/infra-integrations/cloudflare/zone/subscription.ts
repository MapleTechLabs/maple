import { Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../../platform/resources"
import type { PageSubscriptionInput } from "../../../contract"
import { ingestPhaseOf } from "../ingest"
import { dataOf } from "../list/derive"
import { Message, type Model } from "./model"

/** `useCloudflareIngestPhase`'s poll while a connection is still settling. */
const INGEST_POLL = Duration.seconds(30)

const isSettling = (model: Model): boolean => {
	const phase = ingestPhaseOf(dataOf(model.status.data), dataOf(model.usage.data), model.nowMs)
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
						? Stream.fromEffectRepeat(
								Effect.as(Effect.sleep(INGEST_POLL), Message.TickedIngestPoll()),
							)
						: Stream.empty,
			},
		),
	}),
)
