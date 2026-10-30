import { withoutCheckoutReturn } from "../../lib/billing/checkout-return"
import { hasBringYourOwnCloudAddOn } from "../../lib/billing/plan-gating"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { rowToV2ApiKey } from "@maple/web-data/collections/api-keys"
import { Array, Option } from "effect"
import { AsyncData, Command } from "foldkit"
import { AppRoute, hrefOf } from "../../route"
import { type SettingsSearch as SettingsSearchSchema, settingsTabValues } from "../../route/search"

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
		? AsyncData.getOrElse(
				AsyncData.map(model.session, (session) => session.isAdmin),
				() => false,
			)
		: true
	const hasByoc = AsyncData.getOrElse(AsyncData.map(model.customer, hasBringYourOwnCloudAddOn), () => false)
	return {
		isClerk: isClerkAuthEnabled,
		isAdmin,
		canAccessDataPlatform: isAdmin && hasByoc,
		isDataPlatformLocked: isClerkAuthEnabled && isAdmin && !hasByoc,
	}
}

/** The session read answered and says the viewer is a member, not an admin: only then do notices say so. */
export const isKnownMember = (model: Model): boolean =>
	isClerkAuthEnabled &&
	AsyncData.getOrElse(
		AsyncData.map(model.session, (session) => !session.isAdmin),
		() => false,
	)

const isPending = <A, E>(data: AsyncData.AsyncData<A, E>) =>
	AsyncData.isLoading(data) || AsyncData.isIdle(data)

/** The skeleton: the session (Clerk), or the customer while a deep link waits on the gated tab. */
export const isSettingsLoading = (model: Model): boolean =>
	isClerkAuthEnabled &&
	(isPending(model.session) || (model.search.tab === "data-platform" && isPending(model.customer)))

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

type TabOf<T extends TabModel["_tag"]> = Extract<TabModel, { readonly _tag: T }>

/** The open tab or a kept one: a kept tab still takes the answers to what it asked for. */
const tabNamed = <T extends TabModel["_tag"]>(model: Model, tag: T): TabOf<T> | undefined =>
	[model.tab, ...model.kept].find((tab): tab is TabOf<T> => tab !== null && tab._tag === tag)

/** Writes a tab back where it lives: open, or kept. */
const putTab = (model: Model, tab: TabModel): Model =>
	model.tab !== null && model.tab._tag === tab._tag
		? { ...model, tab }
		: { ...model, kept: model.kept.map((kept) => (kept._tag === tab._tag ? tab : kept)) }

/** Closes the open tab, keeping its state for a return. */
const leaveTab = (model: Model): Model =>
	model.tab === null || model.tab._tag === "Unported"
		? { ...model, tab: null }
		: {
				...model,
				tab: null,
				kept: [...model.kept.filter((kept) => kept._tag !== model.tab?._tag), model.tab],
			}

const sessionOf = (model: Model) => ({
	isAdmin: visibilityOf(model).isAdmin,
	userId: AsyncData.getOrElse(
		AsyncData.map(model.session, (session) => session.userId),
		() => null,
	),
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
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotIngestionMessage({ message }),
				),
			}
		}
		case "Mcp": {
			const step = Mcp.init()
			return {
				model: { ...model, tab: { _tag: "Mcp", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotMcpMessage({ message }),
				),
			}
		}
		case "Keys": {
			const step = Keys.init(sessionOf(model))
			return {
				model: {
					...model,
					tab: {
						_tag: "Keys",
						model: {
							...step.model,
							apiKeys: model.apiKeys,
							isLoadFailed: model.isApiKeysLoadFailed,
						},
					},
				},
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotKeysMessage({ message }),
				),
			}
		}
		case "SetupHealth": {
			const step = SetupHealth.init()
			return {
				model: { ...model, tab: { _tag: "SetupHealth", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotSetupHealthMessage({ message }),
				),
			}
		}
		case "Ai": {
			// `canAccessAi`: an admin of an org in the `aiAutoTriage` rollout (self-hosted has every rollout).
			const hasFlag = AsyncData.getOrElse(
				AsyncData.map(model.session, (session) => session.hasAiAutoTriage),
				() => false,
			)
			const step = Ai.init(visibilityOf(model).isAdmin && (!isClerkAuthEnabled || hasFlag))
			return {
				model: { ...model, tab: { _tag: "Ai", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotAiMessage({ message }),
				),
			}
		}
		case "Automation": {
			const step = Automation.init(visibilityOf(model).isAdmin)
			return {
				model: { ...model, tab: { _tag: "Automation", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotAutomationMessage({ message }),
				),
			}
		}
		case "AuditLog": {
			const step = AuditLog.init(model.search)
			return {
				model: { ...model, tab: { _tag: "AuditLog", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotAuditLogMessage({ message }),
				),
			}
		}
		case "DataPlatform": {
			const step = DataPlatform.init()
			return {
				model: { ...model, tab: { _tag: "DataPlatform", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotDataPlatformMessage({ message }),
				),
			}
		}
		case "General": {
			const step = General.init(visibilityOf(model).isAdmin)
			return {
				model: { ...model, tab: { _tag: "General", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotGeneralMessage({ message }),
				),
			}
		}
		case "Members": {
			const step = Members.init(visibilityOf(model).isAdmin)
			return {
				model: { ...model, tab: { _tag: "Members", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotMembersMessage({ message }),
				),
			}
		}
		case "Billing": {
			const visibility = visibilityOf(model)
			const step = Billing.init(
				visibility.isAdmin,
				model.search.checkout === "complete",
				visibility.isClerk,
			)
			return {
				model: { ...model, tab: { _tag: "Billing", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotBillingMessage({ message }),
				),
			}
		}
		case "Unported":
			return { model: { ...model, tab: { _tag: "Unported", tab } } }
	}
}

/** A kept tab back on screen: its data stays while it reads again. */
const revisitTab = (model: Model, kept: TabModel, context: PageContext): Return => {
	switch (kept._tag) {
		case "Ingestion": {
			const step = Ingestion.revisit(kept.model, ingestionOptionsOf(model, context))
			return {
				model: { ...model, tab: { _tag: "Ingestion", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotIngestionMessage({ message }),
				),
			}
		}
		case "Mcp": {
			const step = Mcp.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "Mcp", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotMcpMessage({ message }),
				),
			}
		}
		case "Keys":
			// The key list lives on the page, which kept reading it.
			return {
				model: {
					...model,
					tab: {
						_tag: "Keys",
						model: {
							...kept.model,
							apiKeys: model.apiKeys,
							isLoadFailed: model.isApiKeysLoadFailed,
						},
					},
				},
			}
		case "SetupHealth": {
			const step = SetupHealth.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "SetupHealth", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotSetupHealthMessage({ message }),
				),
			}
		}
		case "Ai": {
			const step = Ai.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "Ai", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotAiMessage({ message }),
				),
			}
		}
		case "Automation": {
			const step = Automation.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "Automation", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotAutomationMessage({ message }),
				),
			}
		}
		case "AuditLog": {
			const step = AuditLog.revisit(kept.model, model.search)
			return {
				model: { ...model, tab: { _tag: "AuditLog", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotAuditLogMessage({ message }),
				),
			}
		}
		case "DataPlatform": {
			const step = DataPlatform.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "DataPlatform", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotDataPlatformMessage({ message }),
				),
			}
		}
		case "General": {
			const step = General.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "General", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotGeneralMessage({ message }),
				),
			}
		}
		case "Members": {
			const step = Members.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "Members", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotMembersMessage({ message }),
				),
			}
		}
		case "Billing": {
			const step = Billing.revisit(kept.model)
			return {
				model: { ...model, tab: { _tag: "Billing", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotBillingMessage({ message }),
				),
			}
		}
		case "Unported":
			return { model: { ...model, tab: kept } }
	}
}

/** Opens `tab`, keeping the one left: a kept tab comes back with its data, any other starts fresh. */
const enterTab = (model: Model, tab: SettingsTab, context: PageContext): Return => {
	const left = leaveTab(model)
	const returning = left.kept.find((kept) => isTabCurrent(kept, tab))
	return returning === undefined
		? initTab(left, tab, context)
		: revisitTab({ ...left, kept: left.kept.filter((kept) => kept !== returning) }, returning, context)
}

/** Mounts the active tab's section once the nav can resolve it, keeping the previous one. */
const syncTab = (model: Model, context: PageContext): Return => {
	if (isSettingsLoading(model)) return { model: leaveTab(model) }
	const tab = activeTabOf(model)
	// A tab this org cannot open (role or plan) replaces the URL with the default tab.
	if (model.search.tab !== undefined && model.search.tab !== tab) {
		const { tab: _hidden, ...search } = model.search
		return {
			model: {
				...leaveTab(model),
				deniedTab: Option.getOrNull(
					Array.findFirst(settingsTabValues, (value) => value === model.search.tab),
				),
			},
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Settings({ search })),
				isReplace: true,
			}),
		}
	}
	// The locked page reads nothing; the tab mounts once the customer shows the add-on.
	if (tab === "data-platform" && visibilityOf(model).isDataPlatformLocked === true)
		return { model: leaveTab(model) }
	if (!isTabCurrent(model.tab, tab)) return enterTab(model, tab, context)
	// The audit log's filters live in the search: a change restarts its list.
	if (model.tab !== null && model.tab._tag === "AuditLog") {
		const step = AuditLog.searchChanged(model.tab.model, model.search)
		return {
			model: { ...model, tab: { _tag: "AuditLog", model: step.model } },
			commands: Command.mapMessages(step.commands ?? [], (message) =>
				Message.GotAuditLogMessage({ message }),
			),
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
			model: leaveTab(model),
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
			isApiKeysLoadFailed: false,
			deniedTab: null,
			tab: null,
			kept: [],
		},
		context,
	)
	return {
		...entered,
		commands: [
			ReadSettingsClock(),
			FetchSettingsSession(),
			FetchSettingsCustomer({ refresh: false }),
			...(entered.commands ?? []),
		],
	}
}

// Only the denied link's own rewrite (no `tab`) keeps its note; picking a tab clears it.
export const routeChanged = (model: Model, route: SettingsRoute, context: PageContext): Return =>
	withRuleStats(changedRoute(model, route, context))

const changedRoute = (model: Model, route: SettingsRoute, context: PageContext): Return =>
	enter(
		{
			...model,
			search: route.search,
			deniedTab: route.search.tab === undefined ? model.deniedTab : null,
		},
		context,
	)

const liftIngestion = (
	model: Model,
	current: IngestionModel.Model,
	message: IngestionMessage.Message,
	context: PageContext,
): Return => {
	const step = Ingestion.update(current, message, ingestionOptionsOf(model, context))
	return {
		model: putTab(model, { _tag: "Ingestion", model: step.model }),
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotIngestionMessage({ message: inner }),
		),
		outMessage: step.outMessage,
	}
}

const liftMcp = (model: Model, current: McpModel.Model, message: McpMessage.Message): Return => {
	const step = Mcp.update(current, message)
	return {
		model: putTab(model, { _tag: "Mcp", model: step.model }),
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotMcpMessage({ message: inner }),
		),
		outMessage: step.outMessage,
	}
}

const liftKeys = (model: Model, current: KeysModel.Model, message: KeysMessage.Message): Return => {
	const step = Keys.update(current, message)
	return {
		model: putTab(model, { _tag: "Keys", model: step.model }),
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotKeysMessage({ message: inner }),
		),
		outMessage: step.outMessage,
	}
}

/**
 * `useCheckoutReturn` settled: drop `checkout=complete` from the URL without a history entry. A
 * confirmed plan also has the root re-read the app's customer (plan gate, quota banners).
 */
const clearCheckoutMarker = (model: Model, isConfirmed: boolean) =>
	PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Settings({ search: withoutCheckoutReturn(model.search) })),
		isReplace: true,
		refreshesCustomer: isConfirmed,
	})

/** Lifts a Billing step: its commands, a stale customer read, and the cleared checkout marker. */
const liftBilling = (model: Model, { step, isCustomerStale, checkout }: Billing.Step): Return => {
	const next = putTab(model, { _tag: "Billing", model: step.model })
	// `BILLING_CUSTOMER_KEY`: a cap save, the portal, a plan change or Retry read the customer again.
	return {
		model: isCustomerStale
			? {
					...next,
					customer: Option.getOrElse(AsyncData.revalidate(model.customer), () =>
						AsyncData.Loading(),
					),
				}
			: next,
		commands: [
			...Command.mapMessages(step.commands ?? [], (child) =>
				Message.GotBillingMessage({ message: child }),
			),
			...(isCustomerStale ? [FetchSettingsCustomer({ refresh: true })] : []),
		],
		// A checkout poll re-reads only this page's copy; the app's waits for the confirmed plan.
		outMessage:
			checkout === "Confirmed" || checkout === "TimedOut"
				? (step.outMessage ?? clearCheckoutMarker(model, checkout === "Confirmed"))
				: isCustomerStale && checkout === undefined
					? withCustomerRefresh(step.outMessage)
					: step.outMessage,
	}
}

/** A stale customer is the app's too: the root re-reads it and shows the step's toast, if any. */
const withCustomerRefresh = (out: PageOutMessage | undefined): PageOutMessage =>
	PageOutMessage.RequestedCustomerRefresh(
		out !== undefined && out._tag === "RequestedToast"
			? { toast: { type: out.type, title: out.title, description: out.description } }
			: {},
	)

/** The Billing tab waiting on a checkout return reads every customer answer for the plan. */
const settleCheckout = ({ model, commands, outMessage }: Return): Return => {
	// A kept Billing tab still polls a checkout return, so it settles here too.
	const billing = tabNamed(model, "Billing")
	if (billing === undefined || !AsyncData.isSuccess(model.customer)) return { model, commands, outMessage }
	const settled = Billing.customerChanged(billing.model, model.customer.data)
	if (settled === null) return { model, commands, outMessage }
	const lifted = liftBilling(model, settled)
	return {
		...lifted,
		commands: [...(commands ?? []), ...(lifted.commands ?? [])],
		outMessage: outMessage ?? lifted.outMessage,
	}
}

/** A Billing tab on screen reads the rule stats once the customer and clock give it a cycle. */
const withRuleStats = (ret: Return): Return => {
	const billing = tabNamed(ret.model, "Billing")
	if (billing === undefined) return ret
	const customer = AsyncData.getOrElse(ret.model.customer, () => null)
	const step = Billing.requestRuleStats(billing.model, customer, ret.model.nowMs)
	if (step === null) return ret
	const lifted = liftBilling(ret.model, { step, isCustomerStale: false })
	return { ...ret, model: lifted.model, commands: [...(ret.commands ?? []), ...(lifted.commands ?? [])] }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	withRuleStats(updateMessage(model, message, context))

const updateMessage = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchSession: ({ result }) =>
			settleCheckout(syncTab({ ...model, session: AsyncData.settle(model.session, result) }, context)),
		CompletedFetchCustomer: ({ result }) =>
			settleCheckout(
				syncTab({ ...model, customer: AsyncData.settle(model.customer, result) }, context),
			),
		GotSetupHealthMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "SetupHealth")
			if (tab === undefined) return { model }
			const step = SetupHealth.update(tab.model, inner)
			return {
				model: putTab(model, { _tag: "SetupHealth", model: step.model }),
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotSetupHealthMessage({ message: child }),
				),
			}
		},
		GotAiMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "Ai")
			if (tab === undefined) return { model }
			const step = Ai.update(tab.model, inner)
			return {
				model: putTab(model, { _tag: "Ai", model: step.model }),
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotAiMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotAutomationMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "Automation")
			if (tab === undefined) return { model }
			const step = Automation.update(tab.model, inner)
			return {
				model: putTab(model, { _tag: "Automation", model: step.model }),
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotAutomationMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotAuditLogMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "AuditLog")
			if (tab === undefined) return { model }
			const step = AuditLog.update(tab.model, inner, model.search)
			return {
				model: putTab(model, { _tag: "AuditLog", model: step.model }),
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotAuditLogMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotDataPlatformMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "DataPlatform")
			if (tab === undefined) return { model }
			const step = DataPlatform.update(tab.model, inner)
			return {
				model: putTab(model, { _tag: "DataPlatform", model: step.model }),
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotDataPlatformMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotGeneralMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "General")
			if (tab === undefined) return { model }
			const step = General.update(tab.model, inner)
			return {
				model: putTab(model, { _tag: "General", model: step.model }),
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotGeneralMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotMembersMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "Members")
			if (tab === undefined) return { model }
			const step = Members.update(tab.model, inner)
			return {
				model: putTab(model, { _tag: "Members", model: step.model }),
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotMembersMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotBillingMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "Billing")
			if (tab === undefined) return { model }
			const customer = AsyncData.getOrElse(model.customer, () => null)
			return liftBilling(model, Billing.update(tab.model, inner, customer, model.nowMs))
		},
		GotIngestionMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "Ingestion")
			return tab === undefined ? { model } : liftIngestion(model, tab.model, inner, context)
		},
		ClickedTab: ({ tab }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Settings({ search: { tab, ...auditLogSearchOf(model.search) } })),
				isReplace: false,
			}),
		}),
		GotMcpMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "Mcp")
			return tab === undefined ? { model } : liftMcp(model, tab.model, inner)
		},
		GotKeysMessage: ({ message: inner }) => {
			const tab = tabNamed(model, "Keys")
			if (tab === undefined) return { model }
			// A retry re-arms the page's load watcher over the reconnected collections.
			const next = inner._tag === "ClickedRetryLoad" ? { ...model, isApiKeysLoadFailed: false } : model
			return liftKeys(next, tab.model, inner)
		},
		UpdatedApiKeys: ({ orgId, rows }) => {
			if (orgId !== context.orgId) return { model }
			const apiKeys = rows.map(rowToV2ApiKey)
			const next = { ...model, apiKeys, isApiKeysLoadFailed: false }
			return next.tab !== null && next.tab._tag === "Keys"
				? liftKeys(next, next.tab.model, KeysMessageValue.UpdatedApiKeys({ rows: apiKeys }))
				: { model: next }
		},
		FailedLoadApiKeys: ({ orgId }) => {
			if (orgId !== context.orgId || model.apiKeys !== null) return { model }
			const next = { ...model, isApiKeysLoadFailed: true }
			return next.tab !== null && next.tab._tag === "Keys"
				? liftKeys(next, next.tab.model, KeysMessageValue.FailedLoadApiKeys())
				: { model: next }
		},
	})
