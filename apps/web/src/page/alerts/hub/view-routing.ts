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
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { badge, separator } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { switchControl } from "@maple/views/ui/switch"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { docsLink } from "../../kit/signal-empty-state"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { destinationProvider, providerLogo } from "../shared/providers"
import { createHref } from "../shared/links"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { destinationMenuId } from "./update"
import { chainsSection } from "./view-chains"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { stripClass, dividedList } from "@maple/views/ui/rule"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"
import { Array as Arr, Option } from "effect"

// `AlertsRoutingTab` and `DestinationRow`: the hub's Routing tab.

export const HEALTH_WINDOW = 20
export const DESTINATION_ROW_GRID = "grid grid-cols-[minmax(0,1fr)_110px_140px_110px_auto] items-center gap-4"

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
							typography(h, { size: "sm", tone: "muted", as: "p" }, [
								"Where rules send incidents. Health is read from each destination's last",
								" ",
								String(HEALTH_WINDOW),
								" delivery attempts.",
							]),
						],
					),
					destinationsSection(h, model, inputs, events),
				],
			),
			separator(h, "horizontal", undefined),
			chainsSection(h, model),
			separator(h, "horizontal", undefined),
			h.section(
				[h.Class("space-y-4")],
				[
					h.div(
						[],
						[
							sectionHeading(h, { title: "Delivery log" }),
							typography(h, { size: "sm", tone: "muted", as: "p" }, [
								"Every queued, retried, and completed notification attempt across alert destinations.",
							]),
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
						...(canManage(model) ? [] : [" Ask an org admin to add one."]),
					]),
				]),
				emptyActions(h, [
					...(canManage(model)
						? [
								button(
									h,
									{ size: "sm", attributes: [h.OnClick(Message.ClickedNewDestination())] },
									[icon(h, "PlusIcon"), "Add destination"],
								),
							]
						: []),
					docsLink(h, "destinations"),
				]),
			],
			"py-12",
		)
	return borderedBox(h, { overflow: "x-auto" }, [
		h.div(
			[h.Class("min-w-[760px]")],
			[
				h.div(
					[
						h.Class(
							cn(
								DESTINATION_ROW_GRID,
								typographyClass({ size: "xs", tone: "muted", className: stripClass("head") }),
							),
						),
					],
					[
						h.span([], ["Destination"]),
						h.span([], ["Type"]),
						h.span([], ["Last ", String(HEALTH_WINDOW), " attempts"]),
						h.span([h.Class("text-right")], ["Last delivered"]),
						h.span([], []),
					],
				),
				dividedList(
					h,
					{ as: "ul", bordered: false },
					Arr.map(inputs.destinations, (destination) =>
						destinationRow(h, model, inputs, {
							destination,
							recent: Arr.filter(
								events,
								(event) => event.destinationId === destination.id,
							).slice(0, HEALTH_WINDOW),
						}),
					),
				),
			],
		),
	])
}

const healthTone = (
	destination: AlertDestinationDocument,
	recent: ReadonlyArray<AlertDeliveryEventDocument>,
): Tone => {
	if (!destination.enabled) return destination.disabledAt != null ? "crit" : "neutral"
	if (recent[0]?.status === "failed") return "crit"
	if (Arr.some(recent, (event) => event.status === "failed")) return "warn"
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
	const lastSuccess = Arr.findFirst(recent, (event) => event.status === "success")
	const failed = Arr.filter(recent, (event) => event.status === "failed").length
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
						[
							h.Class(
								cn(
									hstackClass({ gap: "3", shrink: true }),
									!destination.enabled && "opacity-60",
								),
							),
						],
						[
							statusDot(h, { tone: healthTone(destination, recent), size: "lg" }),
							providerLogo(h, {
								type: destination.type,
								chatConnector: destination.chatConnector ?? undefined,
								size: 28,
								isBare: true,
								className: hstackClass({ className: "shrink-0" }),
								isLogoBroken: model.brokenLogos.includes(destination.type),
								onLogoError: Message.FailedLoadProviderLogo({ type: destination.type }),
							}),
							h.div(
								[h.Class("min-w-0")],
								[
									typography(h, { size: "sm", weight: "medium", truncate: true, as: "p" }, [
										destination.name,
									]),
									typography(
										h,
										{ size: "xs", tone: "muted", mono: true, truncate: true, as: "p" },
										[destination.summary],
									),
								],
							),
						],
					),
					typography(h, { size: "xs", tone: "muted" }, [provider.label]),
					deliveryStrip(h, recent, failed),
					h.span(
						[h.Class("text-right text-xs text-muted-foreground tabular-nums")],
						[
							!destination.enabled
								? h.span(
										destination.disabledAt != null
											? [h.Class("text-severity-error")]
											: [],
										[destination.disabledAt != null ? "auto-disabled" : "disabled"],
									)
								: Option.match(lastSuccess, {
										onNone: () => "never",
										onSome: (event) =>
											relativeTime(h, {
												value: event.scheduledAt,
												nowMs: inputs.nowMs,
												timeZone: inputs.timeZone,
												variant: "short",
											}),
									}),
						],
					),
					hstack(h, { gap: "2", justify: "end" }, [
						...switchControl(h, {
							id: `destination-switch-${destination.id}`,
							inputId: `destination-switch-input-${destination.id}`,
							isChecked: destination.enabled,
							isDisabled: !canManage(model),
							ariaLabel: destination.enabled ? "Disable destination" : "Enable destination",
							onToggle: Message.ClickedToggleDestination({ destinationId: destination.id }),
						}),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: !canManage(model),
								isLoading: model.testingDestinationIds.includes(destination.id),
								attributes: [
									h.OnClick(
										Message.ClickedTestDestination({ destinationId: destination.id }),
									),
								],
							},
							[icon(h, "CheckIcon"), "Test"],
						),
						...(canManage(model)
							? [
									rowActionsMenu(h, {
										slotId: menuId,
										model: model.menus[menuId] ?? Menu.init(menuId),
										entries,
										label: `Actions for ${destination.name}`,
										toParentMessage: (message) =>
											Message.GotRowMenuMessage({ menuId, message }),
									}),
								]
							: []),
					]),
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

const deliveryStrip = (h: H, recent: ReadonlyArray<AlertDeliveryEventDocument>, failed: number): Html => {
	if (recent.length === 0) return typography(h, { size: "xs", tone: "muted" }, ["No deliveries yet"])
	const pending = Arr.filter(
		recent,
		(event) => event.status === "queued" || event.status === "processing",
	).length
	const total = recent.length
	// One attempt reads as itself, not "1 of the last 1 attempts".
	const summary =
		total === 1
			? failed > 0
				? "The last attempt failed"
				: pending > 0
					? "The last attempt is pending"
					: "The last attempt was delivered"
			: failed > 0
				? `${failed} of the last ${total} attempts failed`
				: pending > 0
					? `${total - pending} of the last ${total} attempts delivered, ${pending} pending`
					: `Last ${total} attempts delivered`
	return hstack(
		h,
		{
			align: "stretch",
			as: "span",
			className: "h-3.5 cursor-default gap-px",
			attributes: [
				h.DataAttribute("slot", "tooltip-trigger"),
				h.AriaLabel(summary),
				...tooltipTrigger(h, summary),
			],
		},
		Arr.map([...recent].reverse(), (event) =>
			h.span([h.Key(event.id), h.Class(cn("w-1 rounded-2xs", ATTEMPT_CLASS.get(event.status)))]),
		),
	)
}

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
					emptyDescription(h, [
						"Once rules start triggering, delivery attempts will show up here.",
					]),
				]),
				emptyActions(h, [
					...(canManage(model)
						? [
								linkButton(h, { variant: "outline", size: "sm", href: createHref({}) }, [
									"Create an alert rule",
								]),
							]
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
			Arr.flatMap(groups, (group) => [
				tableRow(h, [
					tableCell(
						h,
						[
							eyebrow(h, { className: hstackClass({ gap: "2" }) }, [
								group.label,
								h.span(
									[
										h.Class(
											"tracking-normal normal-case text-foreground-subtle tabular-nums",
										),
									],
									[
										String(group.events.length),
										" ",
										pluralize(group.events.length, "attempt"),
									],
								),
							]),
						],
						"bg-surface-sunken py-1.5",
						[h.Attribute("colspan", "5")],
					),
				]),
				...Arr.map(group.events, (event) => logRow(h, model, inputs, event)),
			]),
		),
	])
}

const logRow = (h: H, model: Model, inputs: RoutingInputs, event: AlertDeliveryEventDocument): Html => {
	const ev = eventTypeMeta[event.eventType]
	const status = deliveryStatusMeta[event.status]
	// Delivery events carry only the type; a `chat` destination's logo comes from its connector.
	const chatConnector = Option.getOrUndefined(
		Option.flatMapNullishOr(
			Arr.findFirst(inputs.destinations, (d) => d.id === event.destinationId),
			(d) => d.chatConnector,
		),
	)
	return tableRow(h, [
		tableCell(h, [
			hstack(h, { gap: "1.5", as: "span" }, [
				badge(h, { variant: status.variant, size: "sm" }, [status.label]),
				...(event.attemptNumber > 1
					? [
							typography(
								h,
								{
									size: "2xs",
									tone: "warning",
									numeric: true,
									attributes: [h.Title(`Attempt ${event.attemptNumber}`)],
								},
								["↻", String(event.attemptNumber)],
							),
						]
					: []),
			]),
		]),
		tableCell(h, [
			h.span(
				[h.Class(cn("flex items-center gap-1.5 text-xs font-medium", TONE_TEXT[ev.tone]))],
				[statusDot(h, { tone: ev.tone }), ev.label],
			),
		]),
		tableCell(h, [
			hstack(h, { gap: "2", as: "span" }, [
				providerLogo(h, {
					type: event.destinationType,
					chatConnector: chatConnector ?? undefined,
					size: 32,
					isBare: true,
					className: hstackClass({ className: "shrink-0" }),
					isLogoBroken: model.brokenLogos.includes(event.destinationType),
					onLogoError: Message.FailedLoadProviderLogo({ type: event.destinationType }),
				}),
				typography(h, { weight: "medium", truncate: true }, [event.destinationName]),
			]),
		]),
		tableCell(
			h,
			event.status === "failed"
				? [
						typography(h, { size: "xs", tone: "error", truncate: true, className: "block" }, [
							event.errorMessage ?? "Delivery failed",
							...(event.responseCode != null
								? [typography(h, { tone: "muted" }, [" · ", String(event.responseCode)])]
								: []),
						]),
					]
				: event.providerReference
					? [
							typography(h, { size: "xs", tone: "muted", truncate: true, className: "block" }, [
								event.providerReference,
							]),
						]
					: [],
			"max-w-0",
		),
		tableCell(
			h,
			[
				h.span(
					[
						h.Class("cursor-default text-muted-foreground tabular-nums"),
						...tooltipTrigger(h, formatAlertDateTime(event.scheduledAt, inputs.timeZone)),
					],
					[formatAlertTime(event.scheduledAt, inputs.timeZone)],
				),
			],
			"text-right",
		),
	])
}
