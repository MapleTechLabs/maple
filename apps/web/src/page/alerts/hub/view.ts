import type { AlertIncidentId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { stableValue } from "../../kit/stable-slice"
import { button, linkButton } from "@maple/views/ui/button"
import { gatedLinkButton } from "../../kit/gated-controls"
import { splitButtonClass } from "@maple/views/ui/split-button"
import { cn } from "@maple/ui/lib/utils"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import type { MenuEntry, MenuItemEntry } from "@maple/views/ui/menu-view"
import * as MenuView from "@maple/views/ui/menu-view"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import type { BreadcrumbEntry } from "../../../shell"
import type { AlertsTab } from "../../../route/search"
import { alertsHref, createHref } from "../../kit/alert-links"
import { newScheduleHref } from "../shared/oncall-schedules"
import { newSloHref } from "../shared/slo-commands"
import { newMonitorHref } from "../../kit/uptime/commands"
import {
	anomalyOverviewOf,
	destinationsOf,
	isAboutService,
	isFirstRun,
	overviewOf,
	resolveIncidentStatus,
	resolveSignal,
	resolveStatus,
	silenceSuggestionsOf,
} from "./derive"
import { Message } from "./message"
import { type Model } from "./model"
import { alertsEmptyState } from "./view-empty"
import { anomalyInbox, inboxFilters } from "./view-anomalies"
import { inboxTab } from "./view-inbox"
import { routingTab } from "./view-routing"
import * as DestinationDialogView from "../destination/view"
import { deleteChainDialog } from "./view-chains"
import { WINDOW_DIALOG_ID } from "./update"
import * as SilenceDialogView from "../silence-dialog/view"
import { silencesTab } from "./view-silences"
import { deleteWindowDialog, hasWindows, maintenanceTab } from "./view-maintenance"
import * as WindowDialogView from "../maintenance-dialog/view"
import { rulesTab } from "./view-rules"
import { deleteMonitorDialog, uptimeTab } from "./view-uptime"
import { slosTab } from "./view-slos"
import { deleteScheduleDialog, hasSchedules, oncallTab, whoIsOnCallStrip } from "./view-oncall"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { canManageAlerts, canRespondToIncidents, denialReason, gatedControl } from "../../kit/session-grants"

type H = HtmlBuilder<Message>

const TAB_LABEL = {
	inbox: "Inbox",
	rules: "Rules",
	uptime: "Uptime",
	slos: "SLOs",
	silences: "Silences",
	maintenance: "Maintenance",
	"on-call": "On-call",
	routing: "Routing",
} as const satisfies Record<AlertsTab, string>

const HUB_SKELETON_ROWS = ["h-14 w-1/2", "h-40 w-full", "h-48 w-full"]

/** `Alerts › <section>`: the sidebar's current sub-item names the page. */
export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Alerts", href: alertsHref({}) },
	{ label: TAB_LABEL[model.tab] },
]

/** A "New rule" menu row: icon, label and one line of what it watches. */
const newRuleItem = (
	h: H,
	value: string,
	label: string,
	iconName: IconName,
	description: string,
	lockedReason?: string,
): MenuEntry => {
	const entry: MenuItemEntry = {
		_tag: "Item",
		value,
		label,
		content: [
			icon(h, iconName, { className: "mt-0.5 self-start" }),
			vstack(h, { gap: "0.5", shrink: true, as: "span" }, [
				typography(h, { size: "sm" }, [label]),
				typography(h, { size: "xs", tone: "muted", className: "whitespace-normal" }, [description]),
			]),
		],
	}
	return lockedReason === undefined
		? entry
		: { ...entry, isDisabled: true, tooltip: { content: [lockedReason] } }
}

/** The Inbox's and Rules' split create button: a telemetry rule, and behind the chevron every kind. */
const newRuleButton = (h: H, model: Model): Html => {
	const serviceName = model.search.serviceName
	return hstack(h, { align: "center" }, [
		gatedLinkButton(
			h,
			model,
			"alerts:manage",
			{ size: "sm", href: createHref({ serviceName }), className: splitButtonClass("lead") },
			[icon(h, "PlusIcon"), "New rule"],
		),
		h.submodel({
			slotId: model.newRuleMenu.id,
			model: model.newRuleMenu,
			view: MenuView.view,
			viewInputs: {
				entries: [
					newRuleItem(
						h,
						"telemetry",
						"Telemetry rule",
						"ChartLineIcon",
						"Error rate, latency or any query on traces, logs and metrics.",
						lockFor(model, "alerts:manage"),
					),
					newRuleItem(
						h,
						"anomaly",
						"Anomaly rule",
						"PulseIcon",
						"Route what Maple's anomaly detector finds for some services, environments or signals.",
						lockFor(model, "alerts:manage"),
					),
					// Each kind is locked by the permission the API checks on its create.
					newRuleItem(
						h,
						"uptime",
						"Uptime check",
						"GlobeIcon",
						"Check a URL, port, DNS record or cron job from outside.",
						lockFor(model, "uptime_monitors:manage"),
					),
					newRuleItem(
						h,
						"slo",
						"SLO",
						"GaugeIcon",
						"An error budget on a service's availability or latency, with burn-rate alerts.",
						lockFor(model, "slos:manage"),
					),
				],
				align: "end",
				className: "w-80",
				toView: ({ trigger, withTrigger }) =>
					h.div(
						[h.Class("contents")],
						withTrigger(
							button(
								h,
								{
									size: "sm",
									className: cn(splitButtonClass("tail"), "px-2"),
									attributes: [h.AriaLabel("More rule types"), ...trigger],
								},
								[icon(h, "ChevronDownIcon", { className: "size-3.5" })],
							),
						),
					),
			},
			toParentMessage: (message) => Message.GotNewRuleMenuMessage({ message }),
		}),
	])
}

const hasRows = <A>(rows: Option.Option<ReadonlyArray<A>>): boolean =>
	Option.exists(rows, (list) => list.length > 0)

/** The denial a create item shows to a viewer without `permission`, else none. */
const lockFor = (model: Model, permission: Policy.Permission): string | undefined =>
	Policy.can(model.grants, permission) ? undefined : denialReason(permission)

const primaryLink = (h: H, model: Model, href: string, label: string, permission: Policy.Permission): Html =>
	gatedControl(h, model, permission, (isDisabled) =>
		isDisabled
			? button(h, { size: "sm", isDisabled }, [icon(h, "PlusIcon"), label])
			: linkButton(h, { size: "sm", href }, [icon(h, "PlusIcon"), label]),
	)

const primaryButton = (h: H, model: Model, onClick: Message, label: string, isBusy = false): Html =>
	gatedControl(h, model, "alerts:manage", (isLocked) =>
		button(h, { size: "sm", isDisabled: isLocked || isBusy, attributes: [h.OnClick(onClick)] }, [
			icon(h, "PlusIcon"),
			label,
		]),
	)

/**
 * The header's one primary action: what the open section lists. A section whose empty state
 * already offers it shows none until it has rows, and a viewer who can't create it sees none.
 */
const headerActions = (
	h: H,
	model: Model,
	tab: AlertsTab,
	overview: Option.Option<AlertsOverviewReady>,
	audience: PageViewInputs["context"]["audience"],
): Html | undefined => {
	// An analyst follows incidents and sets nothing up.
	if (audience === "analyst") return undefined
	if (tab === "inbox" || tab === "rules")
		// The first-run empty state offers the templates and "Start from scratch" to who can create.
		return canManageAlerts(model) && Option.exists(overview, (data) => isFirstRun(model, data, tab))
			? undefined
			: newRuleButton(h, model)
	const serviceName = model.search.serviceName
	switch (tab) {
		case "uptime":
			return hasRows(AsyncData.getData(model.monitors.data))
				? primaryLink(
						h,
						model,
						newMonitorHref({ serviceName }),
						"New monitor",
						"uptime_monitors:manage",
					)
				: undefined
		case "slos":
			return hasRows(AsyncData.getData(model.slos.data))
				? primaryLink(h, model, newSloHref({ serviceName }), "New SLO", "slos:manage")
				: undefined
		case "silences":
			return primaryButton(h, model, Message.ClickedNewSilence(), "New silence")
		case "maintenance":
			return hasWindows(model)
				? primaryButton(h, model, Message.ClickedNewWindow(), "New window", model.nowMs === null)
				: undefined
		case "on-call":
			return hasSchedules(model)
				? primaryLink(h, model, newScheduleHref(), "New schedule", "oncall:manage")
				: undefined
		case "routing":
			return destinationsOf(model).length > 0
				? primaryButton(h, model, Message.ClickedNewDestination(), "Add destination")
				: undefined
	}
}

/** `SyncUnavailable`: the rules or incidents stream stopped before its first answer. */
const SYNC_UNAVAILABLE = makeClientErrorBody({
	_tag: "@maple/web/errors/SyncUnavailable",
	code: "sync_unavailable",
	title: "Couldn't load alerts",
	message: "Live sync is unavailable.",
	retryable: false,
	recovery: "retry",
})

const hubSkeleton = (h: H): Html =>
	skeletonList(h, {
		rows: HUB_SKELETON_ROWS.length,
		gap: "6",
		renderRow: (index) => skeleton(h, HUB_SKELETON_ROWS[index]),
	})

const hubBody = (
	h: H,
	model: Model,
	overview: Option.Option<AlertsOverviewReady>,
	tab: "inbox" | "rules",
): Html =>
	Option.match(overview, {
		onNone: () =>
			model.isLoadFailed
				? errorState(h, {
						failure: SYNC_UNAVAILABLE,
						title: "Couldn't load alerts",
						onRetry: Message.ClickedRetryLoad(),
						className: "py-12",
					})
				: hubSkeleton(h),
		onSome: (data) => {
			const destinations = destinationsOf(model)
			const emptyState = alertsEmptyState(h, {
				canEdit: canManageAlerts(model),
				hasDestinations: destinations.length > 0,
				serviceName: model.search.serviceName,
				onAddDestination: Message.ClickedNewDestination(),
			})
			const acknowledge = canRespondToIncidents(model)
				? {
						onAcknowledge: (incidentId: AlertIncidentId, acknowledged: boolean) =>
							Message.ClickedAcknowledgeIncident({ incidentId, acknowledged }),
						pendingIds: model.acknowledgingIncidentIds,
					}
				: null
			if (tab === "inbox") {
				const signal = resolveSignal(model.search.signal)
				// A team can set up on-call before its first rule, so the strip shows on the empty inbox too.
				if (isFirstRun(model, data, "inbox"))
					return h.div([h.Class("space-y-6")], [...whoIsOnCallStrip(h, model), emptyState])
				const filters = inboxFilters(h, {
					signal,
					status: resolveIncidentStatus(model.search.anomalyStatus),
					serviceName: model.search.serviceName,
					hasAnomalies: Arr.some(data.incidents, (incident) => incident.signalType === "anomaly"),
					// Counted under the same service filter the list applies.
					openAnomalies: Arr.filter(
						data.openIncidents,
						(incident) =>
							incident.signalType === "anomaly" &&
							(model.search.serviceName === undefined ||
								isAboutService(incident, model.search.serviceName)),
					).length,
				})
				const body =
					signal === "anomaly"
						? Option.match(anomalyOverviewOf(model), {
								onNone: () => hubSkeleton(h),
								onSome: (anomalies) =>
									anomalyInbox(h, anomalies, {
										status: resolveIncidentStatus(model.search.anomalyStatus),
										serviceName: model.search.serviceName,
										acknowledge,
									}),
							})
						: inboxTab(h, data, acknowledge, model.focusedIncidentId)
				return h.div([h.Class("space-y-6")], [...whoIsOnCallStrip(h, model), ...filters, body])
			}
			return rulesTab(h, model, {
				data,
				destinations,
				status: resolveStatus(model.search.status),
				emptyState,
			})
		},
	})

const deleteDialog = (h: H, model: Model): Html => {
	const targetName = Option.getOrElse(
		Option.flatMapNullishOr(
			Arr.findFirst(model.destinations ?? [], (row) => row.id === model.confirmDeleteId),
			(row) => row.name,
		),
		() => "destination",
	)
	return confirmDialog(h, {
		slotId: "alerts-delete-destination",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${targetName}?`,
		description: "Alert rules will stop notifying this destination. This cannot be undone.",
		confirmLabel: "Delete destination",
		isPending:
			model.confirmDeleteId !== null && model.deletingDestinationIds.includes(model.confirmDeleteId),
		onConfirm: Message.ClickedConfirmDeleteDestination(),
	})
}

// The dialogs render closed on every hub message; each keeps its tree until its own model or
// inputs change.
const destinationDialog = (h: H, dialog: Model["destinationDialog"], grants: Model["grants"]): Html =>
	h.submodel({
		slotId: "alerts-destination",
		model: dialog,
		view: DestinationDialogView.view,
		viewInputs: { id: "alerts-destination", grants },
		toParentMessage: (message) => Message.GotDestinationDialogMessage({ message }),
	})

const silenceDialog = (
	h: H,
	dialog: Model["silenceDialog"],
	suggestions: ReturnType<typeof silenceSuggestionsOf>,
): Html =>
	h.submodel({
		slotId: "alerts-silence",
		model: dialog,
		view: SilenceDialogView.view,
		viewInputs: { id: "alerts-silence", suggestions },
		toParentMessage: (message) => Message.GotSilenceDialogMessage({ message }),
	})

const windowRulesOf = stableValue((model: Model) =>
	model.rules === null ? null : Arr.map(model.rules, ({ id, name }) => ({ id, name })),
)

const windowDialog = (h: H, dialog: Model["windowDialog"], rules: ReturnType<typeof windowRulesOf>): Html =>
	h.submodel({
		slotId: WINDOW_DIALOG_ID,
		model: dialog,
		view: WindowDialogView.view,
		viewInputs: { id: WINDOW_DIALOG_ID, rules },
		toParentMessage: (message) => Message.GotWindowDialogMessage({ message }),
	})

const destinationDialogSlot = createLazy()
const silenceDialogSlot = createLazy()
const windowDialogSlot = createLazy()

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const tab = model.tab
	const overview = overviewOf(model)
	return h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					title: TAB_LABEL[tab],
					actions: headerActions(h, model, tab, overview, inputs.context.audience),
				},
				[
					tab === "routing"
						? routingTab(h, model, {
								destinations: destinationsOf(model),
								timeZone: inputs.context.timeZone,
								nowMs: model.nowMs ?? 0,
							})
						: tab === "uptime"
							? uptimeTab(h, model, model.nowMs ?? 0, inputs.context.pinnedNamespace)
							: tab === "slos"
								? slosTab(h, model)
								: tab === "silences"
									? silencesTab(h, model, model.nowMs ?? 0, inputs.context.timeZone)
									: tab === "maintenance"
										? maintenanceTab(h, model, model.nowMs ?? 0, inputs.context.timeZone)
										: tab === "on-call"
											? oncallTab(h, model, model.nowMs ?? 0)
											: hubBody(h, model, overview, tab),
				],
			),
			deleteDialog(h, model),
			deleteMonitorDialog(h, model),
			deleteChainDialog(h, model),
			deleteScheduleDialog(h, model),
			deleteWindowDialog(h, model),
			destinationDialogSlot(destinationDialog, [h, model.destinationDialog, model.grants]),
			silenceDialogSlot(silenceDialog, [h, model.silenceDialog, silenceSuggestionsOf(model)]),
			windowDialogSlot(windowDialog, [h, model.windowDialog, windowRulesOf(model)]),
		],
	)
})
