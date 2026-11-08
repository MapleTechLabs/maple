import { allowedTransitionsForAll, MAX_ISSUE_MERGE_SOURCES, type WorkflowState } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import type * as Menu from "@maple/views/ui/menu"
import * as MenuView from "@maple/views/ui/menu-view"
import { SEVERITY_LABEL, SEVERITY_ORDER, severityDot } from "../kit/severity"
import { WORKFLOW_LABEL } from "../kit/workflow"
import { signalsOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { Array as Arr, Order } from "effect"
import { formatNumber } from "@maple/ui/lib/format"
import type { ErrorSignal } from "../../../lib/models/error-signal"

// The issues bulk bar: the selection's actions, pinned to the foot.

type H = HtmlBuilder<Message>

const DOT_ITEM = hstackClass({ gap: "2" })

const bulkMenu = (
	h: H,
	menu: Menu.Model,
	label: string,
	entries: ReadonlyArray<MenuView.MenuEntry>,
	toMessage: (message: Menu.Message) => Message,
): Html =>
	h.submodel({
		slotId: menu.id,
		model: menu,
		view: MenuView.view,
		viewInputs: {
			entries,
			align: "center",
			toView: ({ trigger, withTrigger }) =>
				h.span(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								size: "sm",
								variant: "ghost",
								slot: "dropdown-menu-trigger",
								attributes: trigger,
							},
							[label],
						),
					),
				),
		},
		toParentMessage: toMessage,
	})

const severityEntries = (h: H): ReadonlyArray<MenuView.MenuEntry> => [
	{
		_tag: "Group",
		label: "Set severity",
		entries: [
			{ _tag: "Separator" },
			...Arr.map(SEVERITY_ORDER, (severity): MenuView.MenuEntry => ({
				_tag: "Item",
				value: severity,
				label: SEVERITY_LABEL[severity],
				className: DOT_ITEM,
				content: [severityDot(h, severity), SEVERITY_LABEL[severity]],
			})),
			{
				_tag: "Item",
				value: "none",
				label: "Clear severity",
				className: DOT_ITEM,
				content: [severityDot(h, null), "Clear severity"],
			},
		],
	},
]

const moveEntries = (
	selected: ReadonlyArray<{ readonly state: WorkflowState }>,
): ReadonlyArray<MenuView.MenuEntry> => {
	const targets = allowedTransitionsForAll(Arr.map(selected, (issue) => issue.state))
	const first = selected[0]
	return [
		{
			_tag: "Group",
			label: "Move to state",
			entries: [
				{ _tag: "Separator" },
				...(targets.length === 0
					? [
							{
								_tag: "Item" as const,
								value: "none",
								isDisabled: true,
								label:
									selected.length === 1 && first !== undefined
										? `No moves from ${WORKFLOW_LABEL[first.state]}`
										: "No move applies to every selected issue",
							},
						]
					: Arr.map(targets, (state) => ({
							_tag: "Item" as const,
							value: state,
							label: WORKFLOW_LABEL[state],
						}))),
			],
		},
	]
}

/** One entry per selected issue: picking it keeps that issue and folds the rest into it. */
const mergeEntries = (selected: ReadonlyArray<ErrorSignal>): ReadonlyArray<MenuView.MenuEntry> => [
	{
		_tag: "Group",
		label: "Keep this issue, merge the rest into it",
		entries: [
			{ _tag: "Separator" },
			...Arr.map(
				// The busiest first: usually the one worth keeping.
				Arr.sort(
					selected,
					Order.mapInput(Order.flip(Order.Number), (signal: ErrorSignal) => signal.totalCount),
				),
				(signal): MenuView.MenuEntry => ({
					_tag: "Item",
					value: signal.id,
					label: `${signal.title} · ${signal.serviceName} · ${formatNumber(signal.totalCount)}`,
				}),
			),
		],
	},
]

/**
 * Whether the selection can be merged: 2+ live error issues (alert and integration
 * issues own no fingerprints, and an archived one cannot be merged), few enough for
 * one request, which keeps one issue and folds at most MAX_ISSUE_MERGE_SOURCES into it.
 */
export const canMergeSelection = (
	signals: ReadonlyArray<{
		readonly issue: { readonly kind: ErrorSignal["issue"]["kind"]; readonly archivedAt: string | null }
	}>,
): boolean =>
	signals.length >= 2 &&
	signals.length <= MAX_ISSUE_MERGE_SOURCES + 1 &&
	Arr.every(signals, (signal) => signal.issue.kind === "error" && signal.issue.archivedAt === null)

export const bulkBar = (h: H, model: Model): ReadonlyArray<Html> => {
	const signals = Arr.filter(signalsOf(model), (signal) => model.selectedIds.includes(signal.id))
	const selected = Arr.map(signals, (signal) => ({ id: signal.id, state: signal.issue.workflowState }))
	if (selected.length === 0) return []
	const canMerge = canMergeSelection(signals)
	return [
		hstack(
			h,
			{
				gap: "1",
				align: "center",
				className:
					"pointer-events-auto fixed bottom-4 left-1/2 z-40 -translate-x-1/2 border bg-popover p-1",
				attributes: [h.Role("region"), h.AriaLabel("Bulk actions")],
			},
			[
				h.span(
					[h.Class("px-2 text-xs font-medium tabular-nums text-foreground")],
					[String(selected.length), " selected"],
				),
				button(
					h,
					{ size: "sm", variant: "ghost", attributes: [h.OnClick(Message.ClickedBulkClaim())] },
					["Claim"],
				),
				bulkMenu(h, model.bulkSeverityMenu, "Severity", severityEntries(h), (message) =>
					Message.GotBulkSeverityMenuMessage({ message }),
				),
				bulkMenu(h, model.bulkMoveMenu, "Move to", moveEntries(selected), (message) =>
					Message.GotBulkMoveMenuMessage({ message }),
				),
				...(canMerge
					? [
							bulkMenu(h, model.bulkMergeMenu, "Merge", mergeEntries(signals), (message) =>
								Message.GotBulkMergeMenuMessage({ message }),
							),
						]
					: []),
				iconButton(
					h,
					{ label: "Clear selection", attributes: [h.OnClick(Message.ClickedClearSelection())] },
					[icon(h, "XmarkIcon")],
				),
			],
		),
	]
}
