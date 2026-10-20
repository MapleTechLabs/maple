import { allowedTransitionsForAll, type WorkflowState } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import type * as Menu from "../../../ui/menu"
import * as MenuView from "../../../ui/menu-view"
import { SEVERITY_LABEL, SEVERITY_ORDER, severityDot } from "../kit/severity"
import { WORKFLOW_LABEL } from "../kit/workflow"
import { signalsOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The issues bulk bar: the selection's actions, pinned to the foot.

type H = HtmlBuilder<Message>

const DOT_ITEM = "flex items-center gap-2"

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
			...SEVERITY_ORDER.map((severity): MenuView.MenuEntry => ({
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
	const targets = allowedTransitionsForAll(selected.map((issue) => issue.state))
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
					: targets.map((state) => ({
							_tag: "Item" as const,
							value: state,
							label: WORKFLOW_LABEL[state],
						}))),
			],
		},
	]
}

export const bulkBar = (h: H, model: Model): ReadonlyArray<Html> => {
	const selected = signalsOf(model)
		.filter((signal) => model.selectedIds.includes(signal.id))
		.map((signal) => ({ id: signal.id, state: signal.issue.workflowState }))
	if (selected.length === 0) return []
	return [
		h.div(
			[
				h.Role("region"),
				h.AriaLabel("Bulk actions"),
				h.Class(
					"pointer-events-auto fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 border bg-popover p-1",
				),
			],
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
				iconButton(
					h,
					{ label: "Clear selection", attributes: [h.OnClick(Message.ClickedClearSelection())] },
					[icon(h, "XmarkIcon")],
				),
			],
		),
	]
}
