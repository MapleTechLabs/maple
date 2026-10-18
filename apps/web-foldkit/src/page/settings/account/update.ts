import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Clock, Effect } from "effect"
import { Command } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { Message, type Model, type TabModel } from "./model"
import { type AccountTab, resolveActiveAccountTab } from "./nav"
import * as Profile from "./profile/update"

type Return = PageReturn<Model, Message>
type AccountRoute = Extract<AppRoute, { readonly _tag: "Account" }>

const ReadAccountClock = Command.define("ReadAccountClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const activeTabOf = (model: Model): AccountTab => resolveActiveAccountTab(model.search.tab)

const TAB_TAGS = new Map<AccountTab, TabModel["_tag"]>([
	["profile", "Profile"],
])
const tabTag = (tab: AccountTab): TabModel["_tag"] => TAB_TAGS.get(tab) ?? "Unported"

const isTabCurrent = (current: TabModel | null, tab: AccountTab): boolean =>
	current !== null && current._tag === tabTag(tab) && (current._tag !== "Unported" || current.tab === tab)

const initTab = (model: Model, tab: AccountTab, _context: PageContext): Return => {
	switch (tabTag(tab)) {
		case "Profile": {
			const step = Profile.init()
			return {
				model: { ...model, tab: { _tag: "Profile", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotProfileMessage({ message })),
			}
		}
		case "Unported":
			return { model: { ...model, tab: { _tag: "Unported", tab } } }
	}
}

/** Self-hosted has nothing to manage here: `<Navigate to="/settings" replace />`. */
const enter = (model: Model, context: PageContext): Return => {
	if (!isClerkAuthEnabled)
		return {
			model: { ...model, tab: null },
			outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Settings({ search: {} })), isReplace: true }),
		}
	const tab = activeTabOf(model)
	return isTabCurrent(model.tab, tab) ? { model } : initTab(model, tab, context)
}

export const init = (route: AccountRoute, context: PageContext): Return => {
	const entered = enter({ search: route.search, nowMs: 0, tab: null }, context)
	return { ...entered, commands: [ReadAccountClock(), ...(entered.commands ?? [])] }
}

export const routeChanged = (model: Model, route: AccountRoute, context: PageContext): Return =>
	enter({ ...model, search: route.search }, context)

export const update = (model: Model, message: Message, _context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		ClickedTab: ({ tab }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Account({ search: { tab } })),
				isReplace: false,
			}),
		}),
		GotProfileMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Profile") return { model }
			const step = Profile.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Profile", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotProfileMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
	})
