import { Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import * as ServiceMap from "../../service-map/map/service-map"
import type { PageSubscriptionInput } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	/** Starts once the map exists, so its first emit reaches the map it gates. */
	reducedMotion: entry(
		{ hasMap: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ hasMap: Option.isSome(model.map) }),
			dependenciesToStream: ({ hasMap }) =>
				hasMap
					? Stream.map(ServiceMap.reducedMotionChanges, (message) =>
							Message.GotMapMessage({ message }),
						)
					: Stream.empty,
		},
	),
}))
