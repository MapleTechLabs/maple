import type { Schema } from "effect"
import { Command } from "foldkit"
import { PageOutMessage, type PageReturn } from "../../contract"
import { FetchViews } from "./command"
import { type Message, type Model, OutMessage } from "./model"
import type { Explorer } from "./state"
import { update } from "./update"

// Saved views as a Submodel: the Views button an explorer's toolbar embeds (`/logs`, `/traces`,
// `/metrics`), with its menu and its save, rename and delete dialogs.
export { activeViewOf, init, Message, Model, remembered, SavedView } from "./model"
export { type Explorer, memoHref, readSearch, searchParamsOf } from "./state"
export { control } from "./view"

type Host = { readonly savedViews: Model }

/** The list read an explorer sends on entry, as its own Message. */
export const loadCommand = <PageMessage>(explorer: Explorer, toMessage: (message: Message) => PageMessage) =>
	Command.mapMessage(FetchViews({ surface: explorer.surface, revision: 0 }), toMessage)

/** The search params a picked view holds, as the page that opens it reads them. */
export type ViewSearch = Readonly<Record<string, Schema.Json>>

/**
 * A page's step for the control's Message: the control's update, a picked view as a navigation
 * to its URL, and a failed menu write as a toast. `onOpenedView` lets a page with a draft the
 * URL does not hold (a debounced search box) drop it for the view's.
 */
export const pageStep = <PageModel extends Host, PageMessage>(
	model: PageModel,
	message: Message,
	explorer: Explorer,
	toMessage: (message: Message) => PageMessage,
	onOpenedView?: (model: PageModel, search: ViewSearch) => PageModel,
): PageReturn<PageModel, PageMessage> => {
	const step = update(model.savedViews, message, explorer)
	const next = { ...model, savedViews: step.model }
	const commands = Command.mapMessages(step.commands ?? [], toMessage)
	if (step.outMessage === undefined) return { model: next, commands }
	return OutMessage.match<PageReturn<PageModel, PageMessage>>(step.outMessage, {
		OpenedView: ({ url, search }) => ({
			model: onOpenedView === undefined ? next : onOpenedView(next, search),
			commands,
			outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
		}),
		RequestedToast: ({ type, title, description }) => ({
			model: next,
			commands,
			outMessage: PageOutMessage.RequestedToast({ type, title, description }),
		}),
	})
}
