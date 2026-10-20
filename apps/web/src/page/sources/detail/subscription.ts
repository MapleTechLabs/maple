import { Option } from "effect"
import { Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { subscriptions as integrationSubscriptions } from "../../integrations/subscription"
import { Message } from "./message"
import type { Model } from "./model"

/** The embedded integration's popup, polls and ticks, while an integration source is open. */
export const subscriptions = Subscription.lift(integrationSubscriptions)<
	PageSubscriptionInput<Model>,
	Message
>({
	read: ({ model, context }) =>
		model.connection === null ? Option.none() : Option.some({ model: model.connection, context }),
	toParentMessage: (message) => Message.GotConnectionMessage({ message }),
})
