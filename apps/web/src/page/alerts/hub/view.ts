import { isManagedSignalType } from "@maple/domain/http"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import * as MenuView from "@maple/views/ui/menu-view"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { linkTabStrip } from "../../kit/underline-tabs"
import { alertsHref, createHref } from "../shared/links"
import { newSloHref } from "../shared/slo-commands"
import { type AlertsTab, destinationsOf, overviewOf, resolveStatus, resolveTab } from "./derive"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { alertsEmptyState } from "./view-empty"
import { inboxTab } from "./view-inbox"
import { routingTab } from "./view-routing"
import * as DestinationDialogView from "../destination/view"
import * as ChainDialogView from "../escalation-dialog/view"
import { deleteChainDialog } from "./view-chains"
import { CHAIN_DIALOG_ID } from "./update"
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

// `AlertsPage` and `AlertsHub`: the `/alerts` page and its tabs.

type H = HtmlBuilder<Message>

const ALERTS_TABS: ReadonlyArray<{ value: AlertsTab; label: string }> = [
	{ value: "inbox", label: "Inbox" },
	{ value: "rules", label: "Rules" },
	{ value: "uptime", label: "Uptime" },
	{ value: "slos", label: "SLOs" },
	{ value: "oncall", label: "On-call" },
	{ value: "routing", label: "Routing" },
]

const HUB_SKELETON_ROWS = ["h-14 w-1/2", "h-40 w-full", "h-48 w-full"]

const tabBar = (
	h: H,
	model: Model,
	overview: Option.Option<AlertsOverviewReady>,
	active: AlertsTab,
): Html => {
	const monitorCount = Option.map(AsyncData.getData(model.monitors.data), (monitors) => monitors.length)
	const sloCount = Option.map(AsyncData.getData(model.slos.data), (slos) => slos.length)
	const scheduleCount = Option.map(AsyncData.getData(model.schedules.data), (rows) => rows.length)
	return linkTabStrip(
		h,
		"Alerts sections",
		Arr.map(ALERTS_TABS, (tab) => {
			const count =
				tab.value === "uptime"
					? Option.getOrUndefined(monitorCount)
					: tab.value === "slos"
						? Option.getOrUndefined(sloCount)
						: tab.value === "oncall"
							? Option.getOrUndefined(scheduleCount)
							: Option.match(overview, {
									onNone: () => undefined,
									onSome: (data) =>
										tab.value === "inbox"
											? data.openIncidents.length
											: tab.value === "rules"
												? data.rules.length
												: undefined,
								})
			return {
				key: tab.value,
				href: alertsHref({ ...model.search, tab: tab.value }),
				label: tab.label,
				count: count !== undefined && count > 0 ? count : undefined,
				countTone: tab.value === "inbox" ? "error" : "muted",
				isCurrent: tab.value === active,
				isRouteActive: tab.value === active,
			}
		}),
	)
}

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
			h.span([h.Class("text-sm")], [label]),
			h.span([h.Class("whitespace-normal text-xs text-muted-foreground")], [description]),
		]),
	],
})

/** The split "New rule": the main part opens the telemetry editor, the chevron offers both kinds. */
const newRuleButton = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex items-center")],
		[
			linkButton(
				h,
				{
					size: "sm",
					href: createHref({ serviceName: model.search.serviceName }),
					className: "relative rounded-r-none before:rounded-r-none focus-visible:z-10",
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
										className:
											"relative -ml-px rounded-l-none border-l border-l-primary-foreground/20 px-2 before:rounded-l-none focus-visible:z-10",
										attributes: [h.AriaLabel("More rule types"), ...trigger],
									},
									[icon(h, "ChevronDownIcon", { className: "size-3.5" })],
								),
							),
						),
				},
				toParentMessage: (message) => Message.GotNewRuleMenuMessage({ message }),
			}),
		],
	)

/** The SLOs tab lists some; the empty one offers "New SLO" itself. */
const hasSlos = (model: Model): boolean =>
	Option.exists(AsyncData.getData(model.slos.data), (rows) => rows.length > 0)

// Destinations are a Routing concern, so "New destination" only shows on that tab; "New SLO" likewise.
const headerActions = (h: H, model: Model, tab: AlertsTab): Html =>
	hstack(h, { gap: "2" }, [
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
			if (tab === "inbox")
				return data.rules.length === 0 && !hasManagedIncidents
					? emptyState
					: vstack(h, { gap: "6" }, [...whoIsOnCallStrip(h, model), inboxTab(h, data)])
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
					title: "Alerts",
					actions: headerActions(h, model, tab),
					tabs: tabBar(h, model, overview, tab),
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
								: tab === "oncall"
									? oncallTab(h, model, model.nowMs ?? 0)
									: hubBody(h, model, overview, tab),
				],
			),
			deleteDialog(h, model),
			deleteMonitorDialog(h, model),
			deleteChainDialog(h, model),
			deleteScheduleDialog(h, model),
			h.submodel({
				slotId: CHAIN_DIALOG_ID,
				model: model.chainDialog,
				view: ChainDialogView.view,
				viewInputs: {
					id: CHAIN_DIALOG_ID,
					destinations: model.destinations,
					members: model.members,
					schedules: Option.getOrElse(AsyncData.getData(model.schedules.data), () => []),
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
		],
	)
})
