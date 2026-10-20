import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { Clock, Effect } from "effect"
import { Command } from "foldkit"
import { REVERIFICATION_CANCELLED } from "../../../platform/clerk"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { Message, type Model, type TabModel } from "./model"
import { type AccountTab, resolveActiveAccountTab } from "./nav"
import * as Profile from "./profile/update"
import * as EmailPreferences from "./email-preferences/update"
import * as TwoFactor from "./two-factor/update"
import * as Sessions from "./sessions/update"
import * as Connections from "./connections/update"
import * as Passkeys from "./passkeys/update"
import * as Emails from "./emails/update"
import * as Password from "./password/update"

type Return = PageReturn<Model, Message>
type AccountRoute = Extract<AppRoute, { readonly _tag: "Account" }>

const ReadAccountClock = Command.define("ReadAccountClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const activeTabOf = (model: Model): AccountTab => resolveActiveAccountTab(model.search.tab)

const TAB_TAGS = new Map<AccountTab, TabModel["_tag"]>([
	["profile", "Profile"],
	["password", "Password"],
	["emails", "Emails"],
	["passkeys", "Passkeys"],
	["connections", "Connections"],
	["sessions", "Sessions"],
	["two-factor", "TwoFactor"],
	["email-preferences", "EmailPreferences"],
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
		case "Password": {
			const step = Password.init()
			return {
				model: { ...model, tab: { _tag: "Password", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotPasswordMessage({ message })),
			}
		}
		case "Emails": {
			const step = Emails.init()
			return {
				model: { ...model, tab: { _tag: "Emails", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotEmailsMessage({ message })),
			}
		}
		case "Passkeys": {
			const step = Passkeys.init()
			return {
				model: { ...model, tab: { _tag: "Passkeys", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotPasskeysMessage({ message })),
			}
		}
		case "Connections": {
			const step = Connections.init()
			return {
				model: { ...model, tab: { _tag: "Connections", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotConnectionsMessage({ message })),
			}
		}
		case "Sessions": {
			const step = Sessions.init()
			return {
				model: { ...model, tab: { _tag: "Sessions", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotSessionsMessage({ message })),
			}
		}
		case "TwoFactor": {
			const step = TwoFactor.init()
			return {
				model: { ...model, tab: { _tag: "TwoFactor", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotTwoFactorMessage({ message })),
			}
		}
		case "EmailPreferences": {
			const step = EmailPreferences.init()
			return {
				model: { ...model, tab: { _tag: "EmailPreferences", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotEmailPreferencesMessage({ message })),
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

/** `toastAccountError`: dismissing Clerk's re-verification challenge is a no-op, not an error. */
const withoutCancelledToast = (step: Return): Return =>
	step.outMessage !== undefined &&
	step.outMessage._tag === "RequestedToast" &&
	step.outMessage.title === REVERIFICATION_CANCELLED
		? { ...step, outMessage: undefined }
		: step

export const update = (model: Model, message: Message, _context: PageContext): Return =>
	withoutCancelledToast(updateTab(model, message))

const updateTab = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		ClickedTab: ({ tab }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Account({ search: { tab } })),
				isReplace: false,
			}),
		}),
		GotPasswordMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Password") return { model }
			const step = Password.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Password", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotPasswordMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotEmailsMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Emails") return { model }
			const step = Emails.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Emails", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotEmailsMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotPasskeysMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Passkeys") return { model }
			const step = Passkeys.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Passkeys", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotPasskeysMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotConnectionsMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Connections") return { model }
			const step = Connections.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Connections", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotConnectionsMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotSessionsMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Sessions") return { model }
			const step = Sessions.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Sessions", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotSessionsMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotTwoFactorMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "TwoFactor") return { model }
			const step = TwoFactor.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "TwoFactor", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotTwoFactorMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotEmailPreferencesMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "EmailPreferences") return { model }
			const step = EmailPreferences.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "EmailPreferences", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotEmailPreferencesMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
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
