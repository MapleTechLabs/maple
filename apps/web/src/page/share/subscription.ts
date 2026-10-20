import { Duration, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { refreshSecondsOf } from "./update"

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	/** `useIntervalRefresh`: the URL's or the board's cadence, once the window resolved. */
	autoRefresh: entry(
		{ seconds: Schema.Number },
		{
			modelToDependencies: ({ model }) => ({ seconds: model.window === null ? 0 : refreshSecondsOf(model) }),
			dependenciesToStream: ({ seconds }) =>
				seconds <= 0
					? Stream.empty
					: Stream.tick(Duration.seconds(seconds)).pipe(
							Stream.drop(1),
							Stream.filter(() => !document.hidden),
							Stream.map(() => Message.TickedAutoRefresh()),
						),
		},
	),
}))
