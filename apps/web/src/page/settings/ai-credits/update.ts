import { AsyncData } from "foldkit"
import type { PageContext, PageReturn } from "../../contract"
import type { AppRoute } from "../../../route"
import { FetchAiCreditUsage } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type AiCreditsRoute = Extract<AppRoute, { readonly _tag: "BillingAiCredits" }>

export const init = (_route: AiCreditsRoute, _context: PageContext): Return => ({
	model: { usage: AsyncData.Loading() },
	commands: [FetchAiCreditUsage()],
})

export const update = (model: Model, message: Message, _context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchUsage: ({ result }) => ({
			model: { ...model, usage: AsyncData.settle(model.usage, result) },
		}),
		ClickedRetry: () => ({
			model: { ...model, usage: AsyncData.Loading() },
			commands: [FetchAiCreditUsage()],
		}),
	})
