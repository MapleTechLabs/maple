import { Clock, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { oncallTabHref } from "../shared/oncall-schedules"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** The preview's now line follows the clock, on the schedule page's 30-second cadence. */
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

/** `/alerts/schedules/new`: one instance per schedule being edited, or the new one. */
export const page = definePage(
	"AlertsScheduleNew",
	{ Model, Message },
	{
		routes: ["AlertsScheduleNew"],
		key: (route) => route.search.scheduleId ?? "new",
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: () => [
			{ label: "Alerts", href: "/alerts" },
			{ label: "On-call", href: oncallTabHref() },
		],
	},
)
