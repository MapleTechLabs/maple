import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Clock, Duration, Effect, Option, Schema, Stream } from "effect"
import { AsyncData, Dom, Subscription } from "foldkit"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { isLiveOf } from "./derive"
import { Message } from "./message"
import { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view } from "./view"
import { pollTicks } from "../../../data/poll"

const LIVE_REFRESH_INTERVAL = Duration.seconds(15)

const LIST_KEYS = new Map<string, "Next" | "Previous" | "Open" | "Escape">([
	["j", "Next"],
	["J", "Next"],
	["ArrowDown", "Next"],
	["k", "Previous"],
	["K", "Previous"],
	["ArrowUp", "Previous"],
	["Enter", "Open"],
	["Escape", "Escape"],
])

const isInteractiveTarget = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement &&
	target.closest("button, a, [role='button'], [role='menuitem'], [role='option']") !== null

/** `useListNavigation`'s hotkeys; suspended while a dialog owns the keyboard or a field has focus. */
const listKeys: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) => {
		const key = LIST_KEYS.get(event.key)
		if (key === undefined || event.metaKey || event.ctrlKey || event.altKey) return Option.none()
		if ((key === "Next" || key === "Previous") && event.shiftKey) return Option.none()
		if (isEditableTarget(event.target) || isDialogOpen()) return Option.none()
		if (key === "Open" && isInteractiveTarget(event.target)) return Option.none()
		if (key === "Next" || key === "Previous") event.preventDefault()
		return Option.some(Message.PressedListKey({ key }))
	},
})

/** `useIntervalRefresh`: the first page again every 15 s while Live (paused while hidden or offline). */
const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	listKeys: entry(
		{ hasRows: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ hasRows: AsyncData.hasData(model.firstPage.data) }),
			dependenciesToStream: ({ hasRows }) => (hasRows ? listKeys : Stream.empty),
		},
	),
	live: entry(
		{ isLive: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isLive: isLiveOf(model.search) }),
			dependenciesToStream: ({ isLive }) =>
				isLive
					? pollTicks(LIVE_REFRESH_INTERVAL).pipe(
							Stream.mapEffect(() =>
								Effect.map(Clock.currentTimeMillis, (nowMs) => Message.TickedLiveRefresh({ nowMs })),
							),
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
