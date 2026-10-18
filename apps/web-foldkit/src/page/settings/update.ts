import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import { AppRoute, hrefOf } from "../../route"
import type { SettingsSearch as SettingsSearchSchema } from "../../route/search"

type SettingsSearch = typeof SettingsSearchSchema.Type
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { FetchSettingsCustomer, FetchSettingsSession, ReadSettingsClock } from "./command"
import { Message } from "./message"
import type { Model, TabModel } from "./model"
import type * as McpMessage from "./mcp/message"
import type * as McpModel from "./mcp/model"
import * as Mcp from "./mcp/update"
import {
	type LegacySettingsRedirect,
	resolveActiveSettingsTab,
	resolveLegacySettingsTab,
	type SettingsTab,
	visibleSections,
	visibleTabs,
	type Visibility,
} from "./nav"

type Return = PageReturn<Model, Message>
type SettingsRoute = Extract<AppRoute, { readonly _tag: "Settings" }>

// VISIBILITY (`useVisibleSettingsSections`)

export const visibilityOf = (model: Model): Visibility => {
	const isAdmin = isClerkAuthEnabled
		? AsyncData.getOrElse(AsyncData.map(model.session, (session) => session.isAdmin), () => false)
		: true
	const hasByoc = AsyncData.getOrElse(AsyncData.map(model.customer, (customer) => customer.hasByoc), () => false)
	return { isClerk: isClerkAuthEnabled, isAdmin, canAccessDataPlatform: isAdmin && hasByoc }
}

const isPending = <A, E>(data: AsyncData.AsyncData<A, E>) => AsyncData.isLoading(data) || AsyncData.isIdle(data)

/** The skeleton: the session (Clerk), or the customer while a deep link waits on the gated tab. */
export const isSettingsLoading = (model: Model): boolean =>
	isClerkAuthEnabled && (isPending(model.session) || (model.search.tab === "data-platform" && isPending(model.customer)))

export const activeTabOf = (model: Model): SettingsTab =>
	resolveActiveSettingsTab(model.search.tab, visibleTabs(visibleSections(visibilityOf(model))))

// TABS

const tabTag = (tab: SettingsTab): TabModel["_tag"] => (tab === "mcp" ? "Mcp" : "Unported")

const isTabCurrent = (current: TabModel | null, tab: SettingsTab): boolean =>
	current !== null && current._tag === tabTag(tab) && (current._tag !== "Unported" || current.tab === tab)

const initTab = (model: Model, tab: SettingsTab): Return => {
	if (tab === "mcp") {
		const step = Mcp.init()
		return {
			model: { ...model, tab: { _tag: "Mcp", model: step.model } },
			commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotMcpMessage({ message })),
		}
	}
	return { model: { ...model, tab: { _tag: "Unported", tab } } }
}

/** Mounts the active tab's section once the nav can resolve it, dropping the previous one. */
const syncTab = (model: Model): Return => {
	if (isSettingsLoading(model)) return { model: { ...model, tab: null } }
	const tab = activeTabOf(model)
	return isTabCurrent(model.tab, tab) ? { model } : initTab(model, tab)
}

// NAVIGATION

const redirectUrl = (redirect: LegacySettingsRedirect): string => {
	switch (redirect.kind) {
		case "integrations":
			return hrefOf(AppRoute.Integrations({ search: {} }))
		case "account":
			return hrefOf(AppRoute.Account({ search: { tab: "email-preferences" } }))
		case "tab":
			return hrefOf(AppRoute.Settings({ search: { tab: redirect.tab } }))
	}
}

/** `pickAuditLogSearch`: the audit filters ride along on a tab switch. */
const auditLogSearchOf = (search: SettingsSearch): SettingsSearch => ({
	range: search.range,
	since: search.since,
	until: search.until,
	actor: search.actor,
	actor_type: search.actor_type,
	outcome: search.outcome,
})

/** Retired `?tab=` values `<Navigate replace>` to their new home before the page renders. */
const enter = (model: Model): Return =>
	Option.match(resolveLegacySettingsTab(model.search.tab), {
		onNone: () => syncTab(model),
		onSome: (redirect) => ({
			model: { ...model, tab: null },
			outMessage: PageOutMessage.RequestedNavigation({ url: redirectUrl(redirect), isReplace: true }),
		}),
	})

// ENTRY

export const init = (route: SettingsRoute, _context: PageContext): Return => {
	const entered = enter({
		search: route.search,
		nowMs: 0,
		session: AsyncData.Loading(),
		customer: AsyncData.Loading(),
		tab: null,
	})
	return {
		...entered,
		commands: [ReadSettingsClock(), FetchSettingsSession(), FetchSettingsCustomer(), ...(entered.commands ?? [])],
	}
}

export const routeChanged = (model: Model, route: SettingsRoute, _context: PageContext): Return =>
	enter({ ...model, search: route.search })

const liftMcp = (model: Model, current: McpModel.Model, message: McpMessage.Message): Return => {
	const step = Mcp.update(current, message)
	return {
		model: { ...model, tab: { _tag: "Mcp", model: step.model } },
		commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotMcpMessage({ message: inner })),
		outMessage: step.outMessage,
	}
}

export const update = (model: Model, message: Message, _context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchSession: ({ result }) => syncTab({ ...model, session: AsyncData.settle(model.session, result) }),
		CompletedFetchCustomer: ({ result }) => syncTab({ ...model, customer: AsyncData.settle(model.customer, result) }),
		ClickedTab: ({ tab }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Settings({ search: { tab, ...auditLogSearchOf(model.search) } })),
				isReplace: false,
			}),
		}),
		GotMcpMessage: ({ message: inner }) =>
			model.tab !== null && model.tab._tag === "Mcp" ? liftMcp(model, model.tab.model, inner) : { model },
	})
