import { Option } from "effect"
import { Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { subscriptions as integrationSubscriptions } from "../../integrations/subscription"
import { Message } from "./message"
import type { Model } from "./model"

/** The integrations module's popup, polls and ticks: the connect step and the picker's statuses. */
export const subscriptions = Subscription.lift(integrationSubscriptions)<
	PageSubscriptionInput<Model>,
	Message
>({
	read: ({ model, context }) => Option.some({ model: model.integrations, context }),
	toParentMessage: (message) => Message.GotIntegrationsMessage({ message }),
})
