import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { pollTicks } from "../../../data/poll"
import { implementPage, type PageSubscriptionInput } from "../../contract"
import { entry } from "./index"
import { isLive } from "../kit/format"
import { runOf } from "./derive"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** A live run, its events and its ledger are read again every 5 s; it stops once the run finishes. */
const POLL = Duration.seconds(5)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	live: entry(
		{ isLive: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => {
				const run = runOf(model)
				return { isLive: run !== null && isLive(run) }
			},
			dependenciesToStream: ({ isLive: live }) =>
				live
					? pollTicks(POLL).pipe(
							Stream.mapEffect(() =>
								Effect.map(Clock.currentTimeMillis, (nowMs) => Message.TickedPoll({ nowMs })),
							),
						)
					: Stream.empty,
		},
	),
}))

export const implementation = implementPage(entry, {
	init,
	update,
	view,
	subscriptions,
	breadcrumbs: breadcrumbsOf,
})
