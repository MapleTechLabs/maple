import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { implementPage, type PageSubscriptionInput } from "../../contract"
import { entry } from "./index"
import { incidentOf } from "./derive"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"
import { pollTicks } from "../../../data/poll"

/** `useIntervalRefresh`: an open incident and its series re-read every 15 s (paused while hidden or offline). */
const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	live: entry(
		{ isOpen: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				isOpen: incidentOf(model).pipe(
					(incident) => incident._tag === "Some" && incident.value.status === "open",
				),
			}),
			dependenciesToStream: ({ isOpen }) =>
				isOpen
					? pollTicks(Duration.seconds(15)).pipe(
							Stream.mapEffect(() =>
								Effect.map(Clock.currentTimeMillis, (nowMs) =>
									Message.TickedLiveRefresh({ nowMs }),
								),
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
