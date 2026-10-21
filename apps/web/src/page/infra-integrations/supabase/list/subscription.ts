import { Duration, Option, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import { pollTicks } from "../../../../data/poll"
import type { Resources } from "../../../../platform/resources"
import type { PageSubscriptionInput } from "../../../contract"
import { projectViews } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

/** Re-reads while a switched-on project has no metrics yet, so its first scrape shows up unaided. */
const WAITING_REFRESH = Duration.seconds(30)

const isWaiting = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => false,
		onSome: (status) =>
			status.connected &&
			!status.revoked &&
			AsyncData.isSuccess(model.projects.data) &&
			projectViews(status, model.projects.data.data).some(
				(project) => project.collection === "waiting",
			),
	})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		waitingRefresh: entry(
			{ isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isWaiting: isWaiting(model) }),
				dependenciesToStream: ({ isWaiting: waiting }) =>
					waiting
						? Stream.map(pollTicks(WAITING_REFRESH), () => Message.TickedWaitingRefresh())
						: Stream.empty,
			},
		),
	}),
)
