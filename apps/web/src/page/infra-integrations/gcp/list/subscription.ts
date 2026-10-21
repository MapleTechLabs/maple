import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { Resources } from "../../../../platform/resources"
import type { PageSubscriptionInput } from "../../../contract"
import { isSettling, metricsConnectors, noticeOf, pageStateOf, statusOf, successOf } from "./derive"
import { Message, type Model } from "./model"
import { pollTicks } from "../../../../data/poll"

// The page's `useIntervalRefresh` calls: the status while connected (faster while a connection
// settles), the fleet while waiting on a first read or quiet, the inventory while it is empty.

const SETTLING_REFRESH = Duration.seconds(10)
const STEADY_REFRESH = Duration.seconds(60)
const WAITING_REFRESH = Duration.seconds(30)
const EMPTY_RESOURCES_REFRESH = Duration.seconds(30)

/** `LIVE_CLOCK_INTERVAL_MS`. */
const LIVE_CLOCK = Duration.seconds(30)

const liveClock = Stream.fromEffectRepeat(
	Effect.andThen(Effect.sleep(LIVE_CLOCK), () =>
		Effect.map(Clock.currentTimeMillis, (nowMs) => Message.TickedLiveClock({ nowMs })),
	),
)

const every = (interval: Duration.Duration, message: Message) =>
	Stream.map(pollTicks(interval), () => message)

const statusCadence = (model: Model): "off" | "settling" | "steady" => {
	const status = statusOf(model)
	if (status === null || status.connectors.length === 0) return "off"
	return isSettling(status, model.nowMs) ? "settling" : "steady"
}

const fleetWaiting = (model: Model): boolean => {
	const status = statusOf(model)
	if (status === null) return false
	const state = pageStateOf(status, model.nowMs)
	if (state._tag !== "Infra") return false
	const notice = noticeOf(model, metricsConnectors(status))
	return notice?.kind === "waiting" || (notice?.kind === "quiet" && model.search.startTime === undefined)
}

const resourcesEmpty = (model: Model): boolean => successOf(model.resources.data)?.types.length === 0

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		liveClock: entry(
			{ hasStatus: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ hasStatus: statusOf(model) !== null }),
				dependenciesToStream: ({ hasStatus }) => (hasStatus ? liveClock : Stream.empty),
			},
		),
		statusRefresh: entry(
			{ cadence: Schema.Literals(["off", "settling", "steady"]) },
			{
				modelToDependencies: ({ model }) => ({ cadence: statusCadence(model) }),
				dependenciesToStream: ({ cadence }) =>
					cadence === "off"
						? Stream.empty
						: every(
								cadence === "settling" ? SETTLING_REFRESH : STEADY_REFRESH,
								Message.TickedStatusRefresh(),
							),
			},
		),
		fleetRefresh: entry(
			{ isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isWaiting: fleetWaiting(model) }),
				dependenciesToStream: ({ isWaiting }) =>
					isWaiting ? every(WAITING_REFRESH, Message.TickedFleetRefresh()) : Stream.empty,
			},
		),
		resourcesRefresh: entry(
			{ isEmpty: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({
					isEmpty: resourcesEmpty(model) && !AsyncData.isLoading(model.resources.data),
				}),
				dependenciesToStream: ({ isEmpty }) =>
					isEmpty ? every(EMPTY_RESOURCES_REFRESH, Message.TickedResourcesRefresh()) : Stream.empty,
			},
		),
	}),
)
