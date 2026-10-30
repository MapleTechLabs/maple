import type { AlertDeliveryEventDocument, AlertDestinationDocument } from "@maple/domain/http"
import { pluralize } from "@maple/ui/lib/format"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	deliveryStatusMeta,
	eventTypeMeta,
	formatAlertDateTime,
	formatAlertTime,
	groupDeliveryEventsByDay,
} from "@maple/web-data/alerts/form-utils"
import { tableCellStyles } from "@maple/ui/styles/ui/table"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { badge, separator } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import * as Menu from "../../../ui/menu"
import type { MenuEntry } from "../../../ui/menu-view"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import { switchControl } from "../../../ui/switch"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"
import { destinationProvider, providerLogo } from "../shared/providers"
import { createHref } from "../shared/links"
import { Message } from "./message"
import type { Model } from "./model"
import { destinationMenuId } from "./update"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"

// `AlertsRoutingTab` and `DestinationRow`: the hub's Routing tab.

export const HEALTH_WINDOW = 20
export const DESTINATION_ROW_GRID =
	"grid grid-cols-[minmax(0,1fr)_110px_140px_110px_auto] items-center gap-4"

type H = HtmlBuilder<Message>

export type RoutingInputs = Readonly<{
	destinations: ReadonlyArray<AlertDestinationDocument>
	timeZone: string
	nowMs: number
}>

export const routingTab = (h: H, model: Model, inputs: RoutingInputs): Html => {
	const deliveries = AsyncData.getData(model.routingDeliveries.data)
	const events = deliveries._tag === "Some" ? deliveries.value : []
	return h.div(
		[h.Class("space-y-8")],
		[
			h.section(
				[h.Class("space-y-4")],
				[
					h.div(
						[],
						[
							sectionHeading(h, { title: "Destinations" }),
							h.p(
								[h.Class("text-muted-foreground text-sm")],
								[
									"Where rules send incidents. Health is read from each destination's last",
									" ",
									String(HEALTH_WINDOW),
									" delivery attempts.",
								],
							),
						],
					),
					destinationsSection(h, model, inputs, events),
				],
			),
			separator(h, "horizontal", undefined),
			h.section(
				[h.Class("space-y-4")],
				[
					h.div(
						[],
						[
							sectionHeading(h, { title: "Delivery log" }),
							h.p(
								[h.Class("text-muted-foreground text-sm")],
								[
									"Every queued, retried, and completed notification attempt across alert destinations.",
								],
							),
						],
					),
					deliveryLog(h, model, inputs),
				],
			),
		],
	)
}

const destinationsSection = (
	h: H,
	model: Model,
	inputs: RoutingInputs,
	events: ReadonlyArray<AlertDeliveryEventDocument>,
): Html => {
	if (model.destinations === null)
		return h.div([h.Class("space-y-3")], [skeleton(h, "h-24 w-full"), skeleton(h, "h-24 w-full")])
	if (inputs.destinations.length === 0)
		return empty(
			h,
			[
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "PaperPlaneIcon", { size: 18 })]),
					emptyTitle(h, ["No destinations configured"]),
					emptyDescription(h, [
						"Add Slack, PagerDuty, or webhook destinations before creating alert rules.",
						...(model.isAdmin ? [] : [" Ask an org admin to add one."]),
					]),
				]),
				emptyActions(h, [
					...(model.isAdmin
						? [
								button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedNewDestination())] }, [
									icon(h, "PlusIcon"),
									"Add destination",
								]),
							]
						: []),
					docsLink(h, "destinations"),
				]),
			],
			"py-12",
		)
	return h.div(
		[h.Class("overflow-x-auto rounded-md border")],
		[
			h.div(
				[h.Class("min-w-[760px]")],
				[
					h.div(
						[h.Class(cn(DESTINATION_ROW_GRID, "border-b px-4 py-2 text-xs text-muted-foreground"))],
						[
							h.span([], ["Destination"]),
							h.span([], ["Type"]),
							h.span([], ["Last ", String(HEALTH_WINDOW), " attempts"]),
							h.span([h.Class("text-right")], ["Last delivered"]),
							h.span([], []),
						],
					),
					h.ul(
						[h.Class("divide-y")],
						inputs.destinations.map((destination) =>
							destinationRow(h, model, inputs, {
								destination,
								recent: events
									.filter((event) => event.destinationId === destination.id)
									.slice(0, HEALTH_WINDOW),
							}),
						),
					),
				],
			),
		],
	)
}

const healthTone = (
	destination: AlertDestinationDocument,
	recent: ReadonlyArray<AlertDeliveryEventDocument>,
): Tone => {
	if (!destination.enabled) return destination.disabledAt != null ? "crit" : "neutral"
	if (recent[0]?.status === "failed") return "crit"
	if (recent.some((event) => event.status === "failed")) return "warn"
	return recent.length > 0 ? "ok" : "neutral"
}

type RowInputs = Readonly<{
	destination: AlertDestinationDocument
	recent: ReadonlyArray<AlertDeliveryEventDocument>
}>

/** `DestinationRow`; the Model owns the menu, the test and delete pending state, the confirm dialog. */
export const destinationRow = (h: H, model: Model, inputs: RoutingInputs, row: RowInputs): Html => {
	const { destination, recent } = row
	const provider = destinationProvider(destination.type, destination.chatConnector ?? undefined)
	const lastSuccess = recent.find((event) => event.status === "success")
	const failed = recent.filter((event) => event.status === "failed").length
	const problem =
		!destination.enabled && destination.disabledReason
			? `Maple stopped delivering here after repeated failures: ${destination.disabledReason}`
			: destination.lastTestError
	const menuId = destinationMenuId(destination.id)
	const entries: ReadonlyArray<MenuEntry> = [
		{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" },
		{ _tag: "Separator" },
		{
			_tag: "Item",
			value: "delete",
			label: "Delete",
			icon: "TrashIcon",
			variant: "destructive",
			isDisabled: model.deletingDestinationIds.includes(destination.id),
		},
	]
	return h.li(
		[h.Key(destination.id), h.Class("px-4 py-3")],
		[
			h.div(
				[h.Class(DESTINATION_ROW_GRID)],
				[
					h.div(
						[h.Class(cn("flex min-w-0 items-center gap-3", !destination.enabled && "opacity-60"))],
						[
							statusDot(h, { tone: healthTone(destination, recent), size: "lg" }),
							providerLogo(h, {
								type: destination.type,
								chatConnector: destination.chatConnector ?? undefined,
								size: 28,
								isBare: true,
								className: "flex shrink-0 items-center",
								isLogoBroken: model.brokenLogos.includes(destination.type),
								onLogoError: Message.FailedLoadProviderLogo({ type: destination.type }),
							}),
							h.div(
								[h.Class("min-w-0")],
								[
									h.p([h.Class("truncate text-sm font-medium")], [destination.name]),
									h.p(
										[h.Class("truncate font-mono text-xs text-muted-foreground")],
										[destination.summary],
									),
								],
							),
						],
					),
					h.span([h.Class("text-xs text-muted-foreground")], [provider.label]),
					deliveryStrip(h, recent, failed),
					h.span(
						[h.Class("text-right text-xs text-muted-foreground tabular-nums")],
						[
							!destination.enabled
								? h.span(
										destination.disabledAt != null ? [h.Class("text-severity-error")] : [],
										[destination.disabledAt != null ? "auto-disabled" : "disabled"],
									)
								: lastSuccess !== undefined
									? relativeTime(h, {
											value: lastSuccess.scheduledAt,
											nowMs: inputs.nowMs,
											timeZone: inputs.timeZone,
											variant: "short",
											tooltip: "title",
										})
									: "never",
						],
					),
					h.div(
						[h.Class("flex items-center justify-end gap-2")],
						[
							...switchControl(h, {
								id: `destination-switch-${destination.id}`,
								inputId: `destination-switch-input-${destination.id}`,
								isChecked: destination.enabled,
								isDisabled: !model.isAdmin,
								ariaLabel: destination.enabled ? "Disable destination" : "Enable destination",
								onToggle: Message.ClickedToggleDestination({ destinationId: destination.id }),
							}),
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									isDisabled: !model.isAdmin,
									isLoading: model.testingDestinationIds.includes(destination.id),
									attributes: [
										h.OnClick(Message.ClickedTestDestination({ destinationId: destination.id })),
									],
								},
								[icon(h, "CheckIcon"), "Test"],
							),
							...(model.isAdmin
								? [
										rowActionsMenu(h, {
											slotId: menuId,
											model: model.menus[menuId] ?? Menu.init(menuId),
											entries,
											label: `Actions for ${destination.name}`,
											toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
										}),
									]
								: []),
						],
					),
				],
			),
			...(problem
				? [h.p([h.Class("mt-2 break-words pl-5 text-xs text-severity-error")], [problem])]
				: []),
		],
	)
}

const ATTEMPT_CLASS = new Map<AlertDeliveryEventDocument["status"], string>([
	["success", "bg-severity-info"],
	["failed", "bg-severity-error"],
	["queued", "bg-foreground-faint"],
	["processing", "bg-foreground-faint"],
])

// TODO(tooltip): the strip's hover tooltip ("Last N attempts delivered") is not drawn yet.
const deliveryStrip = (h: H, recent: ReadonlyArray<AlertDeliveryEventDocument>, failed: number): Html =>
	recent.length === 0
		? h.span([h.Class("text-xs text-muted-foreground")], ["No deliveries yet"])
		: h.span(
				[
					h.Class("flex h-3.5 cursor-default items-stretch gap-px"),
					h.DataAttribute("slot", "tooltip-trigger"),
					h.AriaLabel(
						failed === 0
							? `Last ${recent.length} attempts delivered`
							: `${failed} of the last ${recent.length} attempts failed`,
					),
				],
				[...recent].reverse().map((event) =>
					h.span([h.Key(event.id), h.Class(cn("w-1 rounded-[1px]", ATTEMPT_CLASS.get(event.status)))]),
				),
			)

// DELIVERY LOG

const deliveryLog = (h: H, model: Model, inputs: RoutingInputs): Html =>
	AsyncData.match(model.routingDeliveries.data, {
		onIdle: () => logSkeleton(h),
		onLoading: () => logSkeleton(h),
		onFailure: (failure) => errorState(h, { failure, title: "Couldn't load delivery history" }),
		onRefreshing: (events) => logTable(h, model, inputs, events),
		onStale: ({ data }) => logTable(h, model, inputs, data),
		onSuccess: (events) => logTable(h, model, inputs, events),
	})

const logSkeleton = (h: H): Html =>
	h.div(
		[h.Class("space-y-2")],
		[skeleton(h, "h-10 w-full"), skeleton(h, "h-10 w-full"), skeleton(h, "h-10 w-full")],
	)

const logTable = (
	h: H,
	model: Model,
	inputs: RoutingInputs,
	events: ReadonlyArray<AlertDeliveryEventDocument>,
): Html => {
	if (events.length === 0)
		return empty(
			h,
			[
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "TruckIcon", { size: 18 })]),
					emptyTitle(h, ["No notifications sent yet"]),
					emptyDescription(h, ["Once rules start triggering, delivery attempts will show up here."]),
				]),
				emptyActions(h, [
					...(model.isAdmin
						? [linkButton(h, { variant: "outline", size: "sm", href: createHref({}) }, ["Create an alert rule"])]
						: []),
					docsLink(h, "destinations"),
				]),
			],
			"py-12",
		)
	const groups = groupDeliveryEventsByDay(events, inputs.timeZone, inputs.nowMs)
	return table(h, {}, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Status"], "w-36"),
				tableHead(h, ["Event"], "w-32"),
				tableHead(h, ["Destination"], "w-60"),
				tableHead(h, ["Detail"]),
				tableHead(h, ["Time"], "w-24 text-right"),
			]),
		]),
		tableBody(
			h,
			groups.flatMap((group) => [
				tableRow(h, [
					h.td(
						[
							h.Attribute("class", cn(tableCellStyles, "bg-surface-sunken py-1.5")),
							h.Attribute("colspan", "5"),
							h.DataAttribute("slot", "table-cell"),
						],
						[
							eyebrow(h, { className: "flex items-center gap-2" }, [
								group.label,
								h.span(
									[h.Class("tracking-normal normal-case text-foreground-subtle tabular-nums")],
									[String(group.events.length), " ", pluralize(group.events.length, "attempt")],
								),
							]),
						],
					),
				]),
				...group.events.map((event) => logRow(h, model, inputs, event)),
			]),
		),
	])
}

const logRow = (h: H, model: Model, inputs: RoutingInputs, event: AlertDeliveryEventDocument): Html => {
	const ev = eventTypeMeta[event.eventType]
	const status = deliveryStatusMeta[event.status]
	return tableRow(h, [
		tableCell(h, [
			h.span(
				[h.Class("flex items-center gap-1.5")],
				[
					badge(h, { variant: status.variant, size: "sm" }, [status.label]),
					...(event.attemptNumber > 1
						? [
								h.span(
									[
										h.Class("text-severity-warn tabular-nums text-2xs"),
										h.Title(`Attempt ${event.attemptNumber}`),
									],
									["↻", String(event.attemptNumber)],
								),
							]
						: []),
				],
			),
		]),
		tableCell(h, [
			h.span(
				[h.Class(cn("flex items-center gap-1.5 text-xs font-medium", TONE_TEXT[ev.tone]))],
				[statusDot(h, { tone: ev.tone }), ev.label],
			),
		]),
		tableCell(h, [
			h.span(
				[h.Class("flex items-center gap-2")],
				[
					providerLogo(h, {
						type: event.destinationType,
						size: 32,
						isBare: true,
						className: "flex shrink-0 items-center",
						isLogoBroken: model.brokenLogos.includes(event.destinationType),
						onLogoError: Message.FailedLoadProviderLogo({ type: event.destinationType }),
					}),
					h.span([h.Class("truncate font-medium")], [event.destinationName]),
				],
			),
		]),
		tableCell(
			h,
			event.status === "failed"
				? [
						h.span(
							[h.Class("block truncate text-xs text-severity-error")],
							[
								event.errorMessage ?? "Delivery failed",
								...(event.responseCode != null
									? [h.span([h.Class("text-muted-foreground")], [" · ", String(event.responseCode)])]
									: []),
							],
						),
					]
				: event.providerReference
					? [h.span([h.Class("block truncate text-xs text-muted-foreground")], [event.providerReference])]
					: [],
			"max-w-0",
		),
		// TODO(tooltip): the full date-time tooltip on the time cell is not drawn yet; it is the title.
		tableCell(
			h,
			[
				h.span(
					[
						h.Class("cursor-default text-muted-foreground tabular-nums"),
						h.Title(formatAlertDateTime(event.scheduledAt, inputs.timeZone)),
					],
					[formatAlertTime(event.scheduledAt, inputs.timeZone)],
				),
			],
			"text-right",
		),
	])
}
