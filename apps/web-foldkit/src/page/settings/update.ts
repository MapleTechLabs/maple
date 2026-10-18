import { hasBringYourOwnCloudAddOn } from "@maple/web/lib/billing/plan-gating"
import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { rowToV2ApiKey } from "@maple/web-data/collections/api-keys"
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
import type * as IngestionMessage from "./ingestion/message"
import type * as IngestionModel from "./ingestion/model"
import * as Ingestion from "./ingestion/update"
import * as SetupHealth from "./setup-health/update"
import * as Ai from "./ai/update"
import * as Billing from "./billing/update"
import * as Members from "./members/update"
import * as General from "./general/update"
import * as DataPlatform from "./data-platform/update"
import * as AuditLog from "./audit-log/update"
import * as Automation from "./automation/update"
import type * as KeysMessage from "./keys/message"
import { Message as KeysMessageValue } from "./keys/message"
import type * as KeysModel from "./keys/model"
import * as Keys from "./keys/update"
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
	const hasByoc = AsyncData.getOrElse(AsyncData.map(model.customer, hasBringYourOwnCloudAddOn), () => false)
	return { isClerk: isClerkAuthEnabled, isAdmin, canAccessDataPlatform: isAdmin && hasByoc }
}

const isPending = <A, E>(data: AsyncData.AsyncData<A, E>) => AsyncData.isLoading(data) || AsyncData.isIdle(data)

/** The skeleton: the session (Clerk), or the customer while a deep link waits on the gated tab. */
export const isSettingsLoading = (model: Model): boolean =>
	isClerkAuthEnabled && (isPending(model.session) || (model.search.tab === "data-platform" && isPending(model.customer)))

export const activeTabOf = (model: Model): SettingsTab =>
	resolveActiveSettingsTab(model.search.tab, visibleTabs(visibleSections(visibilityOf(model))))

// TABS

const TAB_TAGS = new Map<SettingsTab, TabModel["_tag"]>([
	["mcp", "Mcp"],
	["keys", "Keys"],
	["ingestion", "Ingestion"],
	["setup-health", "SetupHealth"],
	["ai", "Ai"],
	["automation", "Automation"],
	["audit-log", "AuditLog"],
	["data-platform", "DataPlatform"],
	["general", "General"],
	["members", "Members"],
	["billing", "Billing"],
])
const tabTag = (tab: SettingsTab): TabModel["_tag"] => TAB_TAGS.get(tab) ?? "Unported"

const isTabCurrent = (current: TabModel | null, tab: SettingsTab): boolean =>
	current !== null && current._tag === tabTag(tab) && (current._tag !== "Unported" || current.tab === tab)

const sessionOf = (model: Model) => ({
	isAdmin: visibilityOf(model).isAdmin,
	userId: AsyncData.getOrElse(AsyncData.map(model.session, (session) => session.userId), () => null),
})

/** The Ingestion tab's options: the quick-start key is the org in Clerk mode, `default` self-hosted. */
export const ingestionOptionsOf = (model: Model, context: PageContext): Ingestion.InitOptions => ({
	isAdmin: visibilityOf(model).isAdmin,
	orgKey: isClerkAuthEnabled ? context.orgId : "default",
	timeZone: context.timeZone,
	pinnedNamespace: context.pinnedNamespace,
})

const initTab = (model: Model, tab: SettingsTab, context: PageContext): Return => {
	switch (tabTag(tab)) {
		case "Ingestion": {
			const step = Ingestion.init(ingestionOptionsOf(model, context))
			return {
				model: { ...model, tab: { _tag: "Ingestion", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotIngestionMessage({ message })),
			}
		}
		case "Mcp": {
			const step = Mcp.init()
			return {
				model: { ...model, tab: { _tag: "Mcp", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotMcpMessage({ message })),
			}
		}
		case "Keys": {
			const step = Keys.init(sessionOf(model))
			return {
				model: { ...model, tab: { _tag: "Keys", model: { ...step.model, apiKeys: model.apiKeys } } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotKeysMessage({ message })),
			}
		}
		case "SetupHealth": {
			const step = SetupHealth.init()
			return {
				model: { ...model, tab: { _tag: "SetupHealth", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotSetupHealthMessage({ message })),
			}
		}
		case "Ai": {
			// `canAccessAi`: an admin of an org in the `aiAutoTriage` rollout (self-hosted has every rollout).
			const hasFlag = AsyncData.getOrElse(AsyncData.map(model.session, (session) => session.hasAiAutoTriage), () => false)
			const step = Ai.init(visibilityOf(model).isAdmin && (!isClerkAuthEnabled || hasFlag))
			return {
				model: { ...model, tab: { _tag: "Ai", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotAiMessage({ message })),
			}
		}
		case "Automation": {
			const step = Automation.init(visibilityOf(model).isAdmin)
			return {
				model: { ...model, tab: { _tag: "Automation", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotAutomationMessage({ message })),
			}
		}
		case "AuditLog": {
			const step = AuditLog.init(model.search)
			return {
				model: { ...model, tab: { _tag: "AuditLog", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotAuditLogMessage({ message })),
			}
		}
		case "DataPlatform": {
			const step = DataPlatform.init()
			return {
				model: { ...model, tab: { _tag: "DataPlatform", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDataPlatformMessage({ message })),
			}
		}
		case "General": {
			const step = General.init(visibilityOf(model).isAdmin)
			return {
				model: { ...model, tab: { _tag: "General", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotGeneralMessage({ message })),
			}
		}
		case "Members": {
			const step = Members.init(visibilityOf(model).isAdmin)
			return {
				model: { ...model, tab: { _tag: "Members", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotMembersMessage({ message })),
			}
		}
		case "Billing": {
			const step = Billing.init(visibilityOf(model).isAdmin)
			return {
				model: { ...model, tab: { _tag: "Billing", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotBillingMessage({ message })),
			}
		}
		case "Unported":
			return { model: { ...model, tab: { _tag: "Unported", tab } } }
	}
}

/** Mounts the active tab's section once the nav can resolve it, dropping the previous one. */
const syncTab = (model: Model, context: PageContext): Return => {
	if (isSettingsLoading(model)) return { model: { ...model, tab: null } }
	const tab = activeTabOf(model)
	if (!isTabCurrent(model.tab, tab)) return initTab(model, tab, context)
	// The audit log's filters live in the search: a change restarts its list.
	if (model.tab !== null && model.tab._tag === "AuditLog") {
		const step = AuditLog.searchChanged(model.tab.model, model.search)
		return {
			model: { ...model, tab: { _tag: "AuditLog", model: step.model } },
			commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotAuditLogMessage({ message })),
		}
	}
	return { model }
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
const enter = (model: Model, context: PageContext): Return =>
	Option.match(resolveLegacySettingsTab(model.search.tab), {
		onNone: () => syncTab(model, context),
		onSome: (redirect) => ({
			model: { ...model, tab: null },
			outMessage: PageOutMessage.RequestedNavigation({ url: redirectUrl(redirect), isReplace: true }),
		}),
	})

// ENTRY

export const init = (route: SettingsRoute, context: PageContext): Return => {
	const entered = enter(
		{
			search: route.search,
			nowMs: 0,
			session: AsyncData.Loading(),
			customer: AsyncData.Loading(),
			apiKeys: null,
			tab: null,
		},
		context,
	)
	return {
		...entered,
		commands: [ReadSettingsClock(), FetchSettingsSession(), FetchSettingsCustomer({ refresh: false }), ...(entered.commands ?? [])],
	}
}

export const routeChanged = (model: Model, route: SettingsRoute, context: PageContext): Return =>
	enter({ ...model, search: route.search }, context)

const liftIngestion = (
	model: Model,
	current: IngestionModel.Model,
	message: IngestionMessage.Message,
	context: PageContext,
): Return => {
	const step = Ingestion.update(current, message, ingestionOptionsOf(model, context))
	return {
		model: { ...model, tab: { _tag: "Ingestion", model: step.model } },
		commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotIngestionMessage({ message: inner })),
		outMessage: step.outMessage,
	}
}

const liftMcp = (model: Model, current: McpModel.Model, message: McpMessage.Message): Return => {
	const step = Mcp.update(current, message)
	return {
		model: { ...model, tab: { _tag: "Mcp", model: step.model } },
		commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotMcpMessage({ message: inner })),
		outMessage: step.outMessage,
	}
}

const liftKeys = (model: Model, current: KeysModel.Model, message: KeysMessage.Message): Return => {
	const step = Keys.update(current, message)
	return {
		model: { ...model, tab: { _tag: "Keys", model: step.model } },
		commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotKeysMessage({ message: inner })),
		outMessage: step.outMessage,
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchSession: ({ result }) =>
			syncTab({ ...model, session: AsyncData.settle(model.session, result) }, context),
		CompletedFetchCustomer: ({ result }) =>
			syncTab({ ...model, customer: AsyncData.settle(model.customer, result) }, context),
		GotSetupHealthMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "SetupHealth") return { model }
			const step = SetupHealth.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "SetupHealth", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotSetupHealthMessage({ message: child })),
			}
		},
		GotAiMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Ai") return { model }
			const step = Ai.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Ai", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotAiMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotAutomationMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Automation") return { model }
			const step = Automation.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Automation", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotAutomationMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotAuditLogMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "AuditLog") return { model }
			const step = AuditLog.update(model.tab.model, inner, model.search)
			return {
				model: { ...model, tab: { _tag: "AuditLog", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotAuditLogMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotDataPlatformMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "DataPlatform") return { model }
			const step = DataPlatform.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "DataPlatform", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotDataPlatformMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotGeneralMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "General") return { model }
			const step = General.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "General", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotGeneralMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotMembersMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Members") return { model }
			const step = Members.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Members", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotMembersMessage({ message: child })),
				outMessage: step.outMessage,
			}
		},
		GotBillingMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Billing") return { model }
			const customer = AsyncData.getOrElse(model.customer, () => null)
			const { step, isCustomerStale } = Billing.update(model.tab.model, inner, customer, model.nowMs)
			const next = { ...model, tab: { _tag: "Billing", model: step.model } } as const
			// `BILLING_CUSTOMER_KEY`: a cap save, the portal, a plan change or Retry read the customer again.
			return {
				model: isCustomerStale
					? { ...next, customer: Option.getOrElse(AsyncData.revalidate(model.customer), () => AsyncData.Loading()) }
					: next,
				commands: [
					...Command.mapMessages(step.commands ?? [], (child) => Message.GotBillingMessage({ message: child })),
					...(isCustomerStale ? [FetchSettingsCustomer({ refresh: true })] : []),
				],
				outMessage: step.outMessage,
			}
		},
		GotIngestionMessage: ({ message: inner }) =>
			model.tab !== null && model.tab._tag === "Ingestion"
				? liftIngestion(model, model.tab.model, inner, context)
				: { model },
		ClickedTab: ({ tab }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Settings({ search: { tab, ...auditLogSearchOf(model.search) } })),
				isReplace: false,
			}),
		}),
		GotMcpMessage: ({ message: inner }) =>
			model.tab !== null && model.tab._tag === "Mcp" ? liftMcp(model, model.tab.model, inner) : { model },
		GotKeysMessage: ({ message: inner }) =>
			model.tab !== null && model.tab._tag === "Keys" ? liftKeys(model, model.tab.model, inner) : { model },
		UpdatedApiKeys: ({ orgId, rows }) => {
			if (orgId !== context.orgId) return { model }
			const apiKeys = rows.map(rowToV2ApiKey)
			const next = { ...model, apiKeys }
			return next.tab !== null && next.tab._tag === "Keys"
				? liftKeys(next, next.tab.model, KeysMessageValue.UpdatedApiKeys({ rows: apiKeys }))
				: { model: next }
		},
	})
