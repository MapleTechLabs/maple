import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { alert, alertDescription } from "../../ui/alert"
import { emptyMessage } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import type { BreadcrumbEntry } from "../../shell"
import { navShell } from "./kit/nav-shell"
import { INLINE_LINK_CLASS } from "./kit/section"
import * as IngestionView from "./ingestion/view"
import * as KeysView from "./keys/view"
import * as McpView from "./mcp/view"
import * as AiView from "./ai/view"
import * as BillingView from "./billing/view"
import * as MembersView from "./members/view"
import * as GeneralView from "./general/view"
import * as DataPlatformView from "./data-platform/view"
import * as AuditLogView from "./audit-log/view"
import * as AutomationView from "./automation/view"
import * as SetupHealthView from "./setup-health/view"
import { Message } from "./message"
import type { Model } from "./model"
import { type SettingsTab, settingsTabLabels, visibleSections, visibleTabs } from "./nav"
import { activeTabOf, isKnownMember, isSettingsLoading, visibilityOf } from "./update"

type H = HtmlBuilder<Message>

const isEmpty = (model: Model): boolean =>
	!isSettingsLoading(model) && visibleTabs(visibleSections(visibilityOf(model))).length === 0

export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> =>
	isSettingsLoading(model) || isEmpty(model)
		? [{ label: "Settings" }]
		: [{ label: "Settings", href: "/settings" }, { label: settingsTabLabels[activeTabOf(model)] }]

const loadingSkeleton = (h: H): Html => h.div([h.Class("space-y-3")], [skeleton(h, "h-40 w-full")])

const tabContent = (h: H, model: Model, inputs: PageViewInputs): ReadonlyArray<Html> => {
	const tab = model.tab
	if (tab === null) return []
	switch (tab._tag) {
		case "Mcp":
			return [
				h.submodel({
					slotId: "settings-mcp",
					model: tab.model,
					view: McpView.view,
					toParentMessage: (message) => Message.GotMcpMessage({ message }),
					viewInputs: {
						isAdmin: visibilityOf(model).isAdmin,
						nowMs: model.nowMs,
						timeZone: inputs.context.timeZone,
					},
				}),
			]
		case "Keys":
			return [
				h.submodel({
					slotId: "settings-keys",
					model: tab.model,
					view: KeysView.view,
					toParentMessage: (message) => Message.GotKeysMessage({ message }),
					viewInputs: { nowMs: model.nowMs, timeZone: inputs.context.timeZone },
				}),
			]
		case "Ingestion":
			return [
				h.submodel({
					slotId: "settings-ingestion",
					model: tab.model,
					view: IngestionView.view,
					toParentMessage: (message) => Message.GotIngestionMessage({ message }),
					viewInputs: {},
				}),
			]
		case "SetupHealth":
			return [
				h.submodel({
					slotId: "settings-setup-health",
					model: tab.model,
					view: SetupHealthView.view,
					toParentMessage: (message) => Message.GotSetupHealthMessage({ message }),
					viewInputs: { nowMs: model.nowMs, timeZone: inputs.context.timeZone },
				}),
			]
		case "Ai":
			return [
				h.submodel({
					slotId: "settings-ai",
					model: tab.model,
					view: AiView.view,
					toParentMessage: (message) => Message.GotAiMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Automation":
			return [
				h.submodel({
					slotId: "settings-automation",
					model: tab.model,
					view: AutomationView.view,
					toParentMessage: (message) => Message.GotAutomationMessage({ message }),
					viewInputs: {
						nowMs: model.nowMs,
						timeZone: inputs.context.timeZone,
						isKnownMember: isKnownMember(model),
					},
				}),
			]
		case "AuditLog":
			return [
				h.submodel({
					slotId: "settings-audit-log",
					model: tab.model,
					view: AuditLogView.view,
					toParentMessage: (message) => Message.GotAuditLogMessage({ message }),
					viewInputs: {
						search: model.search,
						nowMs: model.nowMs,
						timeZone: inputs.context.timeZone,
						apiKeys: model.apiKeys ?? [],
					},
				}),
			]
		case "DataPlatform":
			return [
				h.submodel({
					slotId: "settings-data-platform",
					model: tab.model,
					view: DataPlatformView.view,
					toParentMessage: (message) => Message.GotDataPlatformMessage({ message }),
					viewInputs: { nowMs: model.nowMs, timeZone: inputs.context.timeZone },
				}),
			]
		case "General":
			return [
				h.submodel({
					slotId: "settings-general",
					model: tab.model,
					view: GeneralView.view,
					toParentMessage: (message) => Message.GotGeneralMessage({ message }),
					viewInputs: { isKnownMember: isKnownMember(model) },
				}),
			]
		case "Members":
			return [
				h.submodel({
					slotId: "settings-members",
					model: tab.model,
					view: MembersView.view,
					toParentMessage: (message) => Message.GotMembersMessage({ message }),
					viewInputs: {
						nowMs: model.nowMs,
						timeZone: inputs.context.timeZone,
						isKnownMember: isKnownMember(model),
					},
				}),
			]
		case "Billing":
			return [
				h.submodel({
					slotId: "settings-billing",
					model: tab.model,
					view: BillingView.view,
					toParentMessage: (message) => Message.GotBillingMessage({ message }),
					viewInputs: {
						customer: model.customer,
						adminName: null,
						isKnownMember: isKnownMember(model),
						nowMs: model.nowMs,
						timeZone: inputs.context.timeZone,
					},
				}),
			]
		case "Unported":
			// TODO(settings): every remaining tab is ported tab by tab; until then it renders empty.
			return []
	}
}

/** Why a `?tab=` deep link shows another tab: the viewer cannot open the one it names. */
const gatedTabReason = (model: Model, tab: SettingsTab): string => {
	const label = settingsTabLabels[tab]
	const visibility = visibilityOf(model)
	if (!visibility.isClerk) return `${label} isn't available on this deployment.`
	if (tab === "data-platform" && visibility.isAdmin)
		return `${label} needs the Bring your own cloud add-on.`
	return `You need admin access to view ${label}.`
}

const isRoleUnknown = (model: Model): boolean =>
	visibilityOf(model).isClerk && AsyncData.isFailure(model.session)

/** Tabs whose controls depend on the viewer's role; the others read the same for everyone. */
const ROLE_GATED_TABS: ReadonlySet<SettingsTab> = new Set([
	"general",
	"members",
	"billing",
	"keys",
	"automation",
])

/** The session read failed: admin tabs and controls stay hidden, and the page says so where it matters. */
const roleUnknownReason = (model: Model): string | null => {
	const active = activeTabOf(model)
	if (model.deniedTab !== null && model.deniedTab !== active)
		return `Couldn't confirm your role, so ${settingsTabLabels[model.deniedTab]} is hidden and editing is off. Reload the page to try again.`
	if (!ROLE_GATED_TABS.has(active)) return null
	// The members table still lists everyone's role, so this names permissions, not the role.
	return active === "members"
		? "Couldn't confirm your permissions, so editing is off. Reload the page to try again."
		: "Couldn't confirm your role, so editing is off. Reload the page to try again."
}

const pageNote = (h: H, model: Model): ReadonlyArray<Html> => {
	const reason = isRoleUnknown(model)
		? roleUnknownReason(model)
		: model.deniedTab === null || model.deniedTab === activeTabOf(model)
			? null
			: gatedTabReason(model, model.deniedTab)
	// The add-on gate is the one a viewer can lift themselves, so it links to the plans.
	const linksToPlans =
		!isRoleUnknown(model) && model.deniedTab === "data-platform" && visibilityOf(model).isAdmin
	return reason === null
		? []
		: [
				alert(h, { size: "sm", role: "status", className: "mb-6" }, [
					icon(h, "LockIcon"),
					// One paragraph, so the link runs on after the sentence instead of stacking.
					alertDescription(h, [
						h.p(
							[],
							[
								reason,
								...(linksToPlans
									? [
											" ",
											h.a(
												[
													h.Href(
														hrefOf(
															AppRoute.Settings({ search: { tab: "billing" } }),
														),
													),
													h.Class(INLINE_LINK_CLASS),
												],
												["See plans"],
											),
										]
									: []),
							],
						),
					]),
				]),
			]
}

/** The lead tabs' description, shown under the page `<h1>`. */
const tabDescription = (model: Model): string | undefined => {
	switch (model.tab?._tag) {
		case "Keys":
			return KeysView.description
		case "Members":
			return MembersView.description
		case "AuditLog":
			return AuditLogView.description
		case "SetupHealth":
			return SetupHealthView.description
		default:
			return undefined
	}
}

/** The lead tabs' primary action, in the header row beside the `<h1>`. */
const tabActions = (h: H, model: Model): Html | undefined => {
	const tab = model.tab
	if (tab === null) return undefined
	switch (tab._tag) {
		case "Keys":
			return h.submodel({
				slotId: "settings-keys-actions",
				model: tab.model,
				view: KeysView.headerActions,
				toParentMessage: (message) => Message.GotKeysMessage({ message }),
				viewInputs: { isRoleUnknown: isRoleUnknown(model) },
			})
		case "Members":
			return h.submodel({
				slotId: "settings-members-actions",
				model: tab.model,
				view: MembersView.headerActions,
				toParentMessage: (message) => Message.GotMembersMessage({ message }),
				viewInputs: {},
			})
		default:
			return undefined
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const isLoading = isSettingsLoading(model)
	const empty = isEmpty(model)
	return dashboardPage(
		h,
		{
			title: isLoading || empty ? undefined : settingsTabLabels[activeTabOf(model)],
			description: isLoading || empty ? undefined : tabDescription(model),
			actions: isLoading || empty ? undefined : tabActions(h, model),
			width: "settings",
			// Holds the header row while the session resolves, so the content does not jump down.
			titleContent: isLoading ? skeleton(h, "h-8 w-40") : undefined,
			filters:
				isLoading || empty
					? undefined
					: navShell(h, visibleSections(visibilityOf(model)), activeTabOf(model), (tab) =>
							Message.ClickedTab({ tab }),
						),
		},
		isLoading
			? [loadingSkeleton(h)]
			: empty
				? [emptyMessage(h, {}, ["No settings are available for the current account."])]
				: [...pageNote(h, model), ...tabContent(h, model, inputs)],
	)
})
