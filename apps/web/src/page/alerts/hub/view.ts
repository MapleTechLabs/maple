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
import { navShell, type NavShellCount, type NavShellSection } from "../../kit/nav-shell"
import type { BreadcrumbEntry } from "../../../shell"
import { alertsHref, createHref } from "../shared/links"
import { newSloHref } from "../shared/slo-commands"
import {
	type AlertsTab,
	anomalyOverviewOf,
	destinationsOf,
	isAboutService,
	overviewOf,
	resolveIncidentStatus,
	resolveSignal,
	resolveStatus,
	resolveTab,
} from "./derive"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { alertsEmptyState } from "./view-empty"
import { anomalyInbox, inboxFilters } from "./view-anomalies"
import { inboxTab, unacknowledgedCount } from "./view-inbox"
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

// `AlertsPage` and `AlertsHub`: the `/alerts` page and the rail of its sections.

type H = HtmlBuilder<Message>

const TAB_LABEL = {
	inbox: "Inbox",
	rules: "Rules",
	uptime: "Uptime",
	slos: "SLOs",
	silences: "Silences",
	maintenance: "Maintenance",
	oncall: "On-call",
	routing: "Routing",
} as const satisfies Record<AlertsTab, string>

type RailRow = Readonly<{ tab: AlertsTab; icon: IconName }>

const RAIL: ReadonlyArray<Readonly<{ id: string; title: string; rows: ReadonlyArray<RailRow> }>> = [
	{ id: "triage", title: "Triage", rows: [{ tab: "inbox", icon: "BellIcon" }] },
	{
		id: "monitors",
		title: "Monitors",
		rows: [
			{ tab: "rules", icon: "ChartLineIcon" },
			{ tab: "uptime", icon: "GlobeIcon" },
			{ tab: "slos", icon: "GaugeIcon" },
		],
	},
	{
		id: "quiet",
		title: "Quiet",
		rows: [
			{ tab: "silences", icon: "BellSlashIcon" },
			{ tab: "maintenance", icon: "CalendarIcon" },
		],
	},
	{
		id: "response",
		title: "Response",
		rows: [
			{ tab: "oncall", icon: "UsersIcon" },
			{ tab: "routing", icon: "BranchForkIcon" },
		],
	},
]

const HUB_SKELETON_ROWS = ["h-14 w-1/2", "h-40 w-full", "h-48 w-full"]

/** `Alerts › <section>`: the rail's active row names the page. */
export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Alerts", href: alertsHref({}) },
	{ label: TAB_LABEL[resolveTab(model.search.tab)] },
]

const countOf = (
	model: Model,
	overview: Option.Option<AlertsOverviewReady>,
	tab: AlertsTab,
): number | undefined => {
	const lengthOf = <A>(rows: Option.Option<ReadonlyArray<A>>) =>
		Option.getOrUndefined(Option.map(rows, Arr.length))
	switch (tab) {
		case "uptime":
			return lengthOf(AsyncData.getData(model.monitors.data))
		case "slos":
			return lengthOf(AsyncData.getData(model.slos.data))
		case "oncall":
			return lengthOf(AsyncData.getData(model.schedules.data))
		case "inbox":
			return Option.getOrUndefined(
				Option.map(overview, (data) => unacknowledgedCount(data.openIncidents)),
			)
		case "rules":
			return Option.getOrUndefined(Option.map(overview, (data) => data.rules.length))
		case "silences":
		case "maintenance":
		case "routing":
			return undefined
	}
}

/** The section rail in `dashboardPage`'s side slot, which folds into a sheet below `lg`. */
const rail = (h: H, model: Model, overview: Option.Option<AlertsOverviewReady>, active: AlertsTab): Html =>
	navShell<Message, never>(
		h,
		Arr.map(RAIL, (section): NavShellSection<never> => ({
			id: section.id,
			title: section.title,
			items: Arr.map(section.rows, (row) => {
				const count = countOf(model, overview, row.tab)
				const tone: NavShellCount["tone"] = row.tab === "inbox" ? "error" : "muted"
				return {
					kind: "link",
					id: row.tab,
					label: TAB_LABEL[row.tab],
					icon: row.icon,
					count: count !== undefined && count > 0 ? { value: count, tone } : undefined,
					// The Anomalies view belongs to the Inbox: other sections drop its filters.
					href: alertsHref(
						row.tab === "inbox"
							? { ...model.search, tab: row.tab }
							: {
									...model.search,
									tab: row.tab,
									signal: undefined,
									anomalyStatus: undefined,
									window: undefined,
								},
					),
				}
			}),
		})),
		active,
		(tab) => tab,
		"Alerts sections",
	)

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

/** The split "New rule": the main part opens the telemetry editor, the chevron offers both kinds. */
const newRuleButton = (h: H, model: Model): Html =>
	hstack(h, { align: "center" }, [
		linkButton(
			h,
			{
				size: "sm",
				href: createHref({ serviceName: model.search.serviceName }),
				className: splitButtonClass("lead"),
			},
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

/** The SLOs tab lists some; the empty one offers "New SLO" itself. */
const hasSlos = (model: Model): boolean =>
	Option.exists(AsyncData.getData(model.slos.data), (rows) => rows.length > 0)

// Destinations are a Routing concern, so "New destination" only shows on that tab; "New SLO" likewise.
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
		...(canManage(model) && tab === "slos" && hasSlos(model)
			? [
					linkButton(
						h,
						{
							size: "sm",
							variant: "outline",
							href: newSloHref({ serviceName: model.search.serviceName }),
						},
						[icon(h, "PlusIcon"), "New SLO"],
					),
				]
			: []),
		...(canManage(model) && tab === "oncall" && hasSchedules(model) ? [newScheduleButton(h)] : []),
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
		newRuleButton(h, model),
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
	const tab = resolveTab(model.search.tab)
	const overview = overviewOf(model)
	return h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					title: TAB_LABEL[tab],
					actions: headerActions(h, model, tab),
					filters: rail(h, model, overview, tab),
					filtersLabel: "Alerts",
					filtersWidth: "w-56",
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
										: tab === "oncall"
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
