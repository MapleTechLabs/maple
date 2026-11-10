import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Keyed } from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { pollTicks } from "../../../data/poll"
import type { Status, Usage } from "./data"
import { ingestPhaseOf } from "./ingest"
import { successOf } from "../kit/success-of"

/** The poll while a connection is still settling. */
const INGEST_POLL = Duration.seconds(30)

type IngestModel = Readonly<{
	nowMs: number
	status: Keyed<Status, LoadFailure>
	usage: Keyed<Usage, LoadFailure>
}>

const isSettling = (model: IngestModel): boolean => {
	const phase = ingestPhaseOf(successOf(model.status.data), successOf(model.usage.data), model.nowMs)
	return phase !== null && phase.kind !== "live"
}

/** The Worker and zone pages' subscriptions: a 30 s tick while the connection settles. */
export const ingestPollSubscriptions = <M extends IngestModel, Msg>(ticked: (nowMs: number) => Msg) =>
	Subscription.make<PageSubscriptionInput<M>, Msg, Resources>()((entry) => ({
		ingestPoll: entry(
			{ isSettling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isSettling: isSettling(model) }),
				dependenciesToStream: ({ isSettling: settling }) =>
					settling
						? pollTicks(INGEST_POLL).pipe(
								Stream.mapEffect(() => Effect.map(Clock.currentTimeMillis, ticked)),
							)
						: Stream.empty,
			},
		),
	}))
