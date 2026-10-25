import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../ui/empty"
import { skeleton } from "../../ui/skeleton"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import type { BreadcrumbEntry } from "../../shell"
import { navShell } from "./kit/nav-shell"
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
import { settingsTabLabels, visibleSections, visibleTabs } from "./nav"
import { activeTabOf, isSettingsLoading, visibilityOf } from "./update"

type H = HtmlBuilder<Message>

const isEmpty = (model: Model): boolean =>
	!isSettingsLoading(model) && visibleTabs(visibleSections(visibilityOf(model))).length === 0

export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> =>
	isSettingsLoading(model) || isEmpty(model)
		? [{ label: "Settings" }]
		: [{ label: "Settings", href: "/settings" }, { label: settingsTabLabels[activeTabOf(model)] }]

const loadingSkeleton = (h: H): Html =>
	h.div([h.Class("space-y-3")], [skeleton(h, "h-8 w-56"), skeleton(h, "h-40 w-full")])

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
					viewInputs: { nowMs: model.nowMs, timeZone: inputs.context.timeZone },
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
					viewInputs: {},
				}),
			]
		case "Members":
			return [
				h.submodel({
					slotId: "settings-members",
					model: tab.model,
					view: MembersView.view,
					toParentMessage: (message) => Message.GotMembersMessage({ message }),
					viewInputs: { nowMs: model.nowMs, timeZone: inputs.context.timeZone },
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

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const isLoading = isSettingsLoading(model)
	const empty = isEmpty(model)
	return dashboardPage(
		h,
		{
			title: isLoading || empty ? undefined : settingsTabLabels[activeTabOf(model)],
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
				: tabContent(h, model, inputs),
	)
})
