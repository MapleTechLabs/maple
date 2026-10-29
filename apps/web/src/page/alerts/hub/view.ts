import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import { cn } from "@maple/ui/lib/utils"
import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { errorState } from "../../../ui/error-state"
import { icon, type IconName } from "../../../ui/icon"
import type { MenuEntry } from "../../../ui/menu-view"
import * as MenuView from "../../../ui/menu-view"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
import { alertsHref, createHref } from "../shared/links"
import { type AlertsTab, destinationsOf, overviewOf, resolveStatus, resolveTab } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { alertsEmptyState } from "./view-empty"
import { inboxTab } from "./view-inbox"
import { routingTab } from "./view-routing"
import * as DestinationDialogView from "../destination/view"
import { rulesTab } from "./view-rules"
import { deleteMonitorDialog, uptimeTab } from "./view-uptime"

// `AlertsPage` and `AlertsHub`: the `/alerts` page and its tabs.

type H = HtmlBuilder<Message>

const ALERTS_TABS: ReadonlyArray<{ value: AlertsTab; label: string }> = [
	{ value: "inbox", label: "Inbox" },
	{ value: "rules", label: "Rules" },
	{ value: "uptime", label: "Uptime" },
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
	return underlineTabStrip(
		h,
		{ label: "Alerts sections", navigation: true },
		ALERTS_TABS.map((tab) => {
			const count =
				tab.value === "uptime"
					? Option.getOrUndefined(monitorCount)
					: Option.match(overview, {
							onNone: () => undefined,
							onSome: (data) =>
								tab.value === "inbox"
									? data.openIncidents.length
									: tab.value === "rules"
										? data.rules.length
										: undefined,
						})
			return h.a(
				[
					h.Key(tab.value),
					h.Href(alertsHref({ ...model.search, tab: tab.value })),
					...(tab.value === active ? [h.AriaCurrent("page")] : []),
					h.Class(underlineTabClass(tab.value === active)),
				],
				[
					tab.label,
					...(count !== undefined && count > 0
						? [
								h.span(
									[
										h.Class(
											cn(
												"font-mono text-xs tabular-nums",
												tab.value === "inbox"
													? "text-severity-error"
													: "text-muted-foreground",
											),
										),
									],
									[String(count)],
								),
							]
						: []),
				],
			)
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
		h.span(
			[h.Class("flex min-w-0 flex-col gap-0.5")],
			[
				h.span([h.Class("text-sm")], [label]),
				h.span([h.Class("whitespace-normal text-xs text-muted-foreground")], [description]),
			],
		),
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
						...(model.isAdmin
							? [
									newRuleItem(
										h,
										"uptime",
										"Uptime check",
										"GlobeIcon",
										"Check a URL, port, DNS record or cron job from outside.",
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

// Destinations are a Routing concern, so "New destination" only shows on that tab.
const headerActions = (h: H, model: Model, tab: AlertsTab): Html =>
	h.div(
		[h.Class("flex items-center gap-2")],
		[
			...(model.isAdmin && tab === "routing"
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
		],
	)

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
				isAdmin: model.isAdmin,
				hasDestinations: destinations.length > 0,
				serviceName: model.search.serviceName,
				onAddDestination: model.isAdmin ? Message.ClickedNewDestination() : undefined,
			})
			// An org with only uptime monitors has no visible rules but may have open incidents to show.
			const hasUptimeIncidents = data.openIncidents.some((incident) => incident.signalType === "uptime")
			if (tab === "inbox")
				return data.rules.length === 0 && !hasUptimeIncidents ? emptyState : inboxTab(h, data)
			return rulesTab(h, model, {
				data,
				destinations,
				status: resolveStatus(model.search.status),
				emptyState,
			})
		},
	})

const deleteDialog = (h: H, model: Model): Html => {
	const target = (model.destinations ?? []).find((row) => row.id === model.confirmDeleteId)
	return confirmDialog(h, {
		slotId: "alerts-delete-destination",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${target?.name ?? "destination"}?`,
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
							: hubBody(h, model, overview, tab),
				],
			),
			deleteDialog(h, model),
			deleteMonitorDialog(h, model),
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
