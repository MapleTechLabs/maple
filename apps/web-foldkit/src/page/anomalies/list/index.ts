import { Duration, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { isLiveOf } from "./derive"
import { Message } from "./message"
import { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

const LIVE_REFRESH_INTERVAL = Duration.seconds(15)

/** `useIntervalRefresh`: the first page again every 15 s while Live (ticks skip a hidden tab). */
const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	live: entry(
		{ isLive: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isLive: isLiveOf(model.search) }),
			dependenciesToStream: ({ isLive }) =>
				isLive
					? Stream.tick(LIVE_REFRESH_INTERVAL).pipe(
							Stream.drop(1),
							Stream.filter(() => typeof document === "undefined" || !document.hidden),
							Stream.map(() => Message.TickedLiveRefresh()),
						)
					: Stream.empty,
		},
	),
}))

/** `/anomalies`: one instance; a search change arrives as `routeChanged`. */
export const page = definePage(
	"AnomaliesList",
	{ Model, Message },
	{
		routes: ["Anomalies"],
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Anomalies" }],
	},
)
