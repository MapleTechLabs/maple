import { Clock, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** The now line and the range follow the clock, on the hub's 30-second cadence. */
const CLOCK_TICK = "30 seconds"

const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	clock: entry(Schema.Struct({}).fields, {
		modelToDependencies: () => ({}),
		dependenciesToStream: () =>
			Stream.tick(CLOCK_TICK).pipe(
				Stream.drop(1),
				Stream.mapEffect(() =>
					Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
				),
			),
	}),
}))

/** `/alerts/schedules/$scheduleId`: one instance per schedule. */
export const page = definePage(
	"AlertsSchedule",
	{ Model, Message },
	{
		routes: ["AlertsSchedule"],
		key: (route) => route.scheduleId,
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
