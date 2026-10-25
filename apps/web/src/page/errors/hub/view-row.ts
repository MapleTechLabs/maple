import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { ErrorSignal } from "../../../lib/models/error-signal"
import { skeletonStyles } from "@maple/ui/styles/ui/skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Checkbox from "../../../ui/checkbox"
import { eyebrow } from "../../../ui/eyebrow"
import { skeleton } from "../../../ui/skeleton"
import { AppRoute, hrefOf } from "../../../route"
import { truncatedText } from "../../../ui/truncated-text"
import { serviceDot } from "../../../ui/values"
import { actorAvatar } from "../kit/actor"
import {
	PICKER_HOTKEY,
	type PickerKind,
	severityItems,
	severityPickerTrigger,
	stateItems,
	statePickerTrigger,
} from "../kit/pickers"
import * as QuickPick from "../kit/quick-pick"
import type * as ContextMenu from "../../../ui/context-menu"
import * as ContextMenuView from "../../../ui/context-menu-view"
import { contextMenuTriggerStyles } from "@maple/ui/styles/ui/context-menu"
import { Option } from "effect"
import { rowMenuEntries } from "./row-menu"
import { Message } from "./message"
import {
	formatLastSeen,
	formatTimestamp,
	GENERIC_TYPES,
	signalActivity,
	signalSpark,
	type SparkWindow,
	sparkOf,
} from "./view-signal"

// The error signal header and row skeleton.

/** Lane geometry, shared by the header and the rows so the two cannot drift. */
export const LANE = {
	select: "w-4 shrink-0",
	severity: "w-6 shrink-0",
	identity: "min-w-0 flex-1",
	volume: "hidden w-[52px] shrink-0 items-center justify-end gap-2 @lg/page:flex @2xl/page:w-[148px]",
	spark: "hidden min-w-0 flex-1 @2xl/page:block",
	count: "w-[52px] shrink-0 text-right",
	service: "hidden w-[104px] shrink-0 @xl/page:block",
	state: "hidden w-[104px] shrink-0 @3xl/page:block",
	actor: "w-5 shrink-0",
	lastSeen: "w-[76px] shrink-0 whitespace-nowrap",
} as const

export const ROW_SHELL = "flex items-center gap-3 px-3"

export type HeaderSelection = "none" | "some" | "all"

type H = HtmlBuilder<Message>

/** The column labels; the select lane carries the page-wide checkbox once rows exist. */
export const signalHeader = (h: H, selection: HeaderSelection | null): Html =>
	eyebrow(h, { as: "div", className: cn(ROW_SHELL, "h-7 border-b border-border/60 bg-muted/30") }, [
		h.span(
			[h.Class(cn(LANE.select, "flex items-center justify-center"))],
			selection === null
				? []
				: Checkbox.view(h, {
						model: { isChecked: selection === "all" },
						toParentMessage: () => Message.ToggledAllRows(),
						id: "errors-select-all",
						inputId: "errors-select-all-input",
						isIndeterminate: selection === "some",
						ariaLabel: selection === "all" ? "Deselect all errors" : "Select all errors",
					}),
		),
		h.span([h.Class(LANE.severity)], []),
		h.span([h.Class(LANE.identity)], ["Issue"]),
		h.span(
			[h.Class(LANE.volume)],
			[h.span([h.Class(LANE.spark)], ["Trend · 24h"]), h.span([h.Class(LANE.count)], ["Events"])],
		),
		h.span([h.Class(LANE.service)], ["Service"]),
		h.span([h.Class(LANE.state)], ["Status"]),
		h.span([h.Class(LANE.actor)], []),
		h.span([h.Class(cn(LANE.lastSeen, "text-right"))], ["Last seen"]),
	])

const SKELETON_WIDTHS = ["72%", "48%", "61%", "39%", "55%", "44%"]

/** A row that has not arrived yet, in the lanes it will occupy. */
export const signalRowSkeleton = (h: H, index: number): Html =>
	h.div(
		[h.Class(cn(ROW_SHELL, "h-11")), h.AriaHidden(true)],
		[
			h.span([h.Class(LANE.select)], []),
			h.span(
				[h.Class(cn(LANE.severity, "flex items-center justify-center"))],
				[skeleton(h, "size-3.5 rounded-sm")],
			),
			h.span(
				[h.Class(LANE.identity)],
				[
					h.div([
						h.Class(cn(skeletonStyles, "h-3.5")),
						h.DataAttribute("slot", "skeleton"),
						h.Style({ width: SKELETON_WIDTHS[index % 6] ?? "72%" }),
					]),
				],
			),
			h.span(
				[h.Class(LANE.volume)],
				[
					h.span([h.Class(LANE.spark)], [skeleton(h, "h-4 w-full")]),
					h.span([h.Class(LANE.count)], [skeleton(h, "ml-auto h-3 w-8")]),
				],
			),
			h.span([h.Class(LANE.service)], [skeleton(h, "h-3 w-16")]),
			h.span([h.Class(LANE.state)], [skeleton(h, "h-3 w-20")]),
			h.span([h.Class(LANE.actor)], [skeleton(h, "size-5 rounded-full")]),
			h.span([h.Class(cn(LANE.lastSeen, "flex justify-end"))], [skeleton(h, "h-3 w-7")]),
		],
	)

export type RowState = Readonly<{
	isSelected: boolean
	/** Anything on the page is selected: the checkbox column stays visible for the sweep. */
	isSelecting: boolean
	isFocused: boolean
	timeZone: string
	nowMs: number
	sparkWindow: SparkWindow
	/** This row's open quick-pick, if any. */
	picker: Readonly<{ kind: PickerKind; quickPick: QuickPick.Model }> | null
	/** The right-click menu, when this row was the last one pressed. */
	rowMenu: ContextMenu.Model | null
}>

/** `ErrorSignalRow`: the row is the link; the checkbox and pickers sit inside it. */
export const signalRow = (h: H, signal: ErrorSignal, state: RowState): Html => {
	const href = hrefOf(AppRoute.ErrorIssue({ issueId: signal.id, search: {} }))
	const { dense, isSurging, label } = sparkOf(signal, state.sparkWindow)
	const messageLine = signal.detail.split("\n", 1)[0]?.trim() ?? ""
	const swap = GENERIC_TYPES.has(signal.title) && messageLine !== ""
	const rowTitle = swap ? messageLine : signal.title
	const rowDetail = swap ? signal.title : signal.detail
	const activity = signalActivity(h, signal)
	return rowMenuTrigger(h, signal, state, [
		h.a(
			[
				h.Class(
					cn(
						ROW_SHELL,
						"group/row h-11 text-sm",
						"hover:bg-muted/50 data-focused:bg-muted/40",
						"data-selected:bg-primary/10 data-selected:hover:bg-primary/15",
						"focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
						"transition-colors",
					),
				),
				...(state.isFocused ? [h.DataAttribute("focused", "true")] : []),
				h.DataAttribute("issue-id", signal.id),
				...(state.isSelected ? [h.DataAttribute("selected", "true")] : []),
				h.Href(href),
				h.OnMouseEnter(Message.HoveredRow({ id: signal.id })),
			],
			[
				h.span(
					[
						h.Class(cn(LANE.select, "flex items-center justify-center")),
						h.DataAttribute("row-select", signal.id),
						h.Role("presentation"),
					],
					Checkbox.view(h, {
						model: { isChecked: state.isSelected },
						toParentMessage: () => Message.ToggledRow({ id: signal.id }),
						id: `errors-row-${signal.id}`,
						inputId: `errors-row-${signal.id}-input`,
						ariaLabel: state.isSelected ? "Deselect this error" : "Select this error",
						className: cn(
							"transition-opacity",
							state.isSelecting || state.isSelected
								? "opacity-100"
								: "opacity-0 group-hover/row:opacity-100 group-data-focused/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
						),
					}),
				),
				h.span(
					[h.Class(cn(LANE.severity, "flex items-center justify-center"))],
					[severityPicker(h, signal, state)],
				),
				h.span(
					[h.Class(cn(LANE.identity, "flex items-baseline gap-2"))],
					[
						truncatedText(
							h,
							{
								text: swap ? signal.detail : rowTitle,
								// The exception type never truncates on wide rows; only the detail gives way.
								className:
									"font-medium text-foreground @4xl/page:max-w-[75%] @4xl/page:shrink-0",
							},
							[rowTitle],
						),
						...(rowDetail
							? [
									truncatedText(h, {
										text: rowDetail,
										className: "hidden min-w-0 flex-1 text-muted-foreground @4xl/page:block",
									}),
								]
							: []),
						...(activity === null ? [] : [activity]),
					],
				),
				volumeLane(h, signal, dense, isSurging, label),
				...trailingLanes(h, signal, state),
			],
		),
	])
}

/** `IssueContextMenu`'s trigger around the row; the row last pressed carries the menu itself. */
const rowMenuTrigger = (h: H, signal: ErrorSignal, state: RowState, children: ReadonlyArray<Html>): Html =>
	state.rowMenu === null
		? h.div(
				[
					h.Class(cn(contextMenuTriggerStyles, "select-none")),
					h.DataAttribute("slot", "context-menu-trigger"),
					h.OnPointerDown((_type, _button, _sx, _sy, _t, clientX, clientY) =>
						Option.some(
							Message.PressedRowPointer({ id: signal.id, point: { x: clientX, y: clientY } }),
						),
					),
					h.OnContextMenu(Message.OpenedRowMenu({ id: signal.id })),
				],
				children,
			)
		: h.submodel({
				slotId: state.rowMenu.id,
				model: state.rowMenu,
				view: ContextMenuView.view,
				toParentMessage: (message) => Message.GotRowMenuMessage({ message }),
				viewInputs: {
					entries: rowMenuEntries(h, signal.issue),
					triggerClassName: "select-none",
					triggerContent: [],
					toTriggerContent: () => children,
					className: "w-56 p-1",
				},
			})

const volumeLane = (
	h: H,
	signal: ErrorSignal,
	dense: ReadonlyArray<number>,
	isSurging: boolean,
	label: string,
): Html =>
	h.span(
		[h.Class(LANE.volume)],
		[
			h.span([h.Class(LANE.spark)], [signalSpark(h, dense, signal, isSurging, label)]),
			h.span(
				[
					h.Class(cn(LANE.count, "text-xs tabular-nums")),
					h.Title(
						signal.windowCount === null
							? `None in the last 24 hours · ${signal.totalCount.toLocaleString("en-US")} all time`
							: `${signal.windowCount.toLocaleString("en-US")} in the last 24 hours · ${signal.totalCount.toLocaleString("en-US")} all time`,
					),
				],
				[
					signal.windowCount === null
						? h.span([h.Class("text-muted-foreground/50")], [EMPTY_VALUE])
						: h.span(
								[
									h.Class(
										isSurging
											? "font-medium text-severity-error"
											: "text-muted-foreground",
									),
								],
								[formatNumber(signal.windowCount)],
							),
				],
			),
		],
	)

const trailingLanes = (h: H, signal: ErrorSignal, state: RowState): ReadonlyArray<Html> => [
	h.span(
		[
			h.Class(cn(LANE.service, "items-center gap-1.5 text-xs text-muted-foreground @xl/page:flex")),
			h.Title(signal.serviceName),
		],
		[
			serviceDot(h, { serviceName: signal.serviceName, size: "sm" }),
			h.span([h.Class("truncate")], [signal.serviceName]),
		],
	),
	h.span([h.Class(LANE.state)], [statePicker(h, signal, state)]),
	h.span([h.Class(LANE.actor)], signal.assignee === null ? [] : [actorAvatar(h, signal.assignee)]),
	h.span(
		[
			h.Class(cn(LANE.lastSeen, "text-right text-xs tabular-nums text-muted-foreground")),
			h.Title(`Last seen ${formatTimestamp(signal.lastSeenAt, state.timeZone, true)}`),
		],
		[formatLastSeen(signal.lastSeenAt, state.timeZone, state.nowMs)],
	),
]

const pickerMessage = (message: QuickPick.Message) => Message.GotPickerMessage({ message })

/** The row link (`rowRef`), the picker's anchor while its lane is hidden. */
export const rowSelector = (id: string): string => `a[data-issue-id="${id}"]`

/** `SeverityPicker`: the closed trigger, or the open popover around it. */
const severityPicker = (h: H, signal: ErrorSignal, state: RowState): Html =>
	state.picker?.kind === "severity"
		? QuickPick.view(h, {
				model: state.picker.quickPick,
				items: severityItems(h),
				current: signal.severity ?? "none",
				placeholder: "Change severity…",
				hotkey: PICKER_HOTKEY.severity,
				label: "Severity",
				toMessage: pickerMessage,
				fallbackAnchorSelector: rowSelector(signal.id),
				trigger: (attributes) =>
					severityPickerTrigger(h, signal.severity, undefined, { isOpen: true, attributes }),
				toView: (parts) => h.span([h.Class("contents")], parts),
			})
		: severityPickerTrigger(h, signal.severity, undefined, {
				isOpen: false,
				onClick: Message.ClickedPickerTrigger({ id: signal.id, kind: "severity" }),
			})

/** `StatePicker`. */
const statePicker = (h: H, signal: ErrorSignal, state: RowState): Html => {
	const current = signal.issue.workflowState
	return state.picker?.kind === "state"
		? QuickPick.view(h, {
				model: state.picker.quickPick,
				items: stateItems(h, current),
				current,
				placeholder: "Change status…",
				hotkey: PICKER_HOTKEY.state,
				label: "Status",
				toMessage: pickerMessage,
				fallbackAnchorSelector: rowSelector(signal.id),
				trigger: (attributes) =>
					statePickerTrigger(h, current, undefined, { isOpen: true, attributes }),
				toView: (parts) => h.span([h.Class("contents")], parts),
			})
		: statePickerTrigger(h, current, undefined, {
				isOpen: false,
				onClick: Message.ClickedPickerTrigger({ id: signal.id, kind: "state" }),
			})
}
