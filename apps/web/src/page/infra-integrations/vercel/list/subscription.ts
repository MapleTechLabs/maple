import { Duration, Effect, Option, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { Resources } from "../../../../platform/resources"
import type { PageSubscriptionInput } from "../../../contract"
import { Message, type Model } from "./model"

/** Re-reads while a view is empty, so the drains' first deliveries fill in without a reload. */
const EMPTY_REFRESH = Duration.seconds(15)

/** With neither drain on, an empty page has nothing on the way worth polling for. */
const isProjectsEmpty = (model: Model): boolean =>
	AsyncData.isSuccess(model.projects.data) &&
	model.projects.data.data.length === 0 &&
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => false,
		onSome: (status) => status.logsEnabled || status.tracesEnabled,
	})

const isAiGatewayEmpty = (model: Model): boolean =>
	model.search.view === "aiGateway" &&
	AsyncData.isSuccess(model.aiGateway.data) &&
	model.aiGateway.data.data.summary.requests === 0

const poll = (isEmpty: boolean, slot: "projects" | "aiGateway") =>
	isEmpty
		? Stream.fromEffectRepeat(
				Effect.as(Effect.sleep(EMPTY_REFRESH), Message.TickedEmptyRefresh({ slot })),
			)
		: Stream.empty

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		projectsRefresh: entry(
			{ isEmpty: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isEmpty: isProjectsEmpty(model) }),
				dependenciesToStream: ({ isEmpty }) => poll(isEmpty, "projects"),
			},
		),
		aiGatewayRefresh: entry(
			{ isEmpty: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isEmpty: isAiGatewayEmpty(model) }),
				dependenciesToStream: ({ isEmpty }) => poll(isEmpty, "aiGateway"),
			},
		),
	}),
)
