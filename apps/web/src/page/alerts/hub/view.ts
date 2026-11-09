import { type AlertIncidentId, isManagedSignalType } from "@maple/domain/http"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { splitButtonClass } from "@maple/views/ui/split-button"
import { cn } from "@maple/ui/lib/utils"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import * as MenuView from "@maple/views/ui/menu-view"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import type { BreadcrumbEntry } from "../../../shell"
import type { AlertsTab } from "../../../route/search"
import { alertsHref, createHref } from "../shared/links"
import { newSloHref } from "../shared/slo-commands"
import { newMonitorHref } from "../shared/uptime-commands"
import {
	anomalyOverviewOf,
	destinationsOf,
	isAboutService,
	overviewOf,
	resolveIncidentStatus,
	resolveSignal,
	resolveStatus,
} from "./derive"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { alertsEmptyState } from "./view-empty"
import { anomalyInbox, inboxFilters } from "./view-anomalies"
import { inboxTab } from "./view-inbox"
import { routingTab } from "./view-routing"
import * as DestinationDialogView from "../destination/view"
import * as ChainDialogView from "../escalation-dialog/view"
import { deleteChainDialog } from "./view-chains"
import { CHAIN_DIALOG_ID, WINDOW_DIALOG_ID } from "./update"
import * as SilenceDialogView from "../silence-dialog/view"
import { silencesTab } from "./view-silences"
import { deleteWindowDialog, hasWindows, maintenanceTab } from "./view-maintenance"
import * as WindowDialogView from "../maintenance-dialog/view"
import { rulesTab } from "./view-rules"
import { deleteMonitorDialog, uptimeTab } from "./view-uptime"
import { slosTab } from "./view-slos"
import {
	deleteScheduleDialog,
	hasSchedules,
	newScheduleButton,
	oncallTab,
	whoIsOnCallStrip,
} from "./view-oncall"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// `AlertsPage` and `AlertsHub`: `/alerts` and `/alerts/<section>`. The sidebar lists the sections.

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
): MenuEntry => ({
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
})

/** The split create button: its main part makes the section's own kind (an uptime check on Uptime, an SLO
 * on SLOs, else a telemetry rule), the chevron offers every kind. */
const newRuleButton = (h: H, model: Model, tab: AlertsTab): Html => {
	const serviceName = model.search.serviceName
	// Uptime checks and SLOs are admin-only to create; members keep the telemetry rule.
	const lead =
		canManage(model) && tab === "uptime"
			? { href: newMonitorHref({ serviceName }), label: "New check" }
			: canManage(model) && tab === "slos"
				? { href: newSloHref({ serviceName }), label: "New SLO" }
				: { href: createHref({ serviceName }), label: "New rule" }
	return hstack(h, { align: "center" }, [
		linkButton(
			h,
			{
				size: "sm",
				href: lead.href,
				className: splitButtonClass("lead"),
			},
			[icon(h, "PlusIcon"), lead.label],
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
					),
					newRuleItem(
						h,
						"anomaly",
						"Anomaly rule",
						"PulseIcon",
						"Route what Maple's anomaly detector finds for some services, environments or signals.",
					),
					// Uptime monitors are admin-only to create; the API refuses members too.
					...(canManage(model)
						? [
								newRuleItem(
									h,
									"uptime",
									"Uptime check",
									"GlobeIcon",
									"Check a URL, port, DNS record or cron job from outside.",
								),
								newRuleItem(
									h,
									"slo",
									"SLO",
									"GaugeIcon",
									"An error budget on a service's availability or latency, with burn-rate alerts.",
								),
							]
						: []),
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

// Destinations are a Routing concern, so "New destination" only shows on that tab.
const headerActions = (h: H, model: Model, tab: AlertsTab): Html =>
	hstack(h, { gap: "2" }, [
		...(canManage(model) && tab === "silences"
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							attributes: [h.OnClick(Message.ClickedNewSilence())],
						},
						[icon(h, "BellSlashIcon"), "New silence"],
					),
				]
			: []),
		...(canManage(model) && tab === "maintenance" && hasWindows(model)
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: model.nowMs === null,
							attributes: [h.OnClick(Message.ClickedNewWindow())],
						},
						[icon(h, "CalendarIcon"), "New window"],
					),
				]
			: []),
		...(canManage(model) && tab === "on-call" && hasSchedules(model) ? [newScheduleButton(h)] : []),
		...(canManage(model) && tab === "routing"
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							attributes: [h.OnClick(Message.ClickedNewDestination())],
						},
						[icon(h, "PlusIcon"), "New destination"],
					),
				]
			: []),
		newRuleButton(h, model, tab),
	])

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
				canEdit: canManage(model),
				hasDestinations: destinations.length > 0,
				serviceName: model.search.serviceName,
				onAddDestination: canManage(model) ? Message.ClickedNewDestination() : undefined,
			})
			// An org with only monitors or SLOs has no visible rules but may have open incidents to show.
			const hasManagedIncidents = Arr.some(data.openIncidents, (incident) =>
				isManagedSignalType(incident.signalType),
			)
			const acknowledge = {
				onAcknowledge: (incidentId: AlertIncidentId, acknowledged: boolean) =>
					Message.ClickedAcknowledgeIncident({ incidentId, acknowledged }),
				pendingIds: model.acknowledgingIncidentIds,
			}
			if (tab === "inbox") {
				const signal = resolveSignal(model.search.signal)
				const hasAnomalies = Arr.some(data.incidents, (incident) => incident.signalType === "anomaly")
				// A team can set up on-call before its first rule, so the strip shows on the empty inbox too.
				if (data.rules.length === 0 && !hasManagedIncidents && !hasAnomalies && signal === null)
					return h.div([h.Class("space-y-6")], [...whoIsOnCallStrip(h, model), emptyState])
				const filters = inboxFilters(h, {
					signal,
					status: resolveIncidentStatus(model.search.anomalyStatus),
					serviceName: model.search.serviceName,
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
						: inboxTab(h, data, acknowledge)
				return h.div([h.Class("space-y-6")], [...whoIsOnCallStrip(h, model), filters, body])
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
					actions: headerActions(h, model, tab),
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
			h.submodel({
				slotId: CHAIN_DIALOG_ID,
				model: model.chainDialog,
				view: ChainDialogView.view,
				viewInputs: {
					id: CHAIN_DIALOG_ID,
					destinations: model.destinations,
					members: model.members,
					// `null` until the schedules load (or after a failed read): names read neutrally.
					schedules: Option.getOrNull(AsyncData.getData(model.schedules.data)),
				},
				toParentMessage: (message) => Message.GotChainDialogMessage({ message }),
			}),
			h.submodel({
				slotId: "alerts-destination",
				model: model.destinationDialog,
				view: DestinationDialogView.view,
				viewInputs: { id: "alerts-destination" },
				toParentMessage: (message) => Message.GotDestinationDialogMessage({ message }),
			}),
			h.submodel({
				slotId: "alerts-silence",
				model: model.silenceDialog,
				view: SilenceDialogView.view,
				viewInputs: { id: "alerts-silence" },
				toParentMessage: (message) => Message.GotSilenceDialogMessage({ message }),
			}),
			h.submodel({
				slotId: WINDOW_DIALOG_ID,
				model: model.windowDialog,
				view: WindowDialogView.view,
				viewInputs: {
					id: WINDOW_DIALOG_ID,
					rules:
						model.rules === null ? null : Arr.map(model.rules, ({ id, name }) => ({ id, name })),
				},
				toParentMessage: (message) => Message.GotWindowDialogMessage({ message }),
			}),
		],
	)
})
