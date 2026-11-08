import type { V2Investigation } from "@maple/domain/http/v2"
import {
	AGENT_TARGET_LABEL,
	AGENT_TARGETS,
	type AgentTarget,
	agentDeepLink,
} from "@maple/web-data/investigations/agent-handoff"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { icon, type IconName } from "@maple/views/ui/icon"
import * as MenuView from "@maple/views/ui/menu-view"
import { splitButtonClass } from "@maple/views/ui/split-button"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"
import { handoffInputOf, investigationOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// "Fix in Claude Code": hand the diagnosis to the reader's own coding agent.

type H = HtmlBuilder<Message>

export const AGENT_ICON = {
	"claude-code": "ClaudeIcon",
	cursor: "CursorIcon",
	vscode: "VsCodeIcon",
} as const satisfies Record<AgentTarget, IconName>

/**
 * "Fix in Claude Code": the diagnosis as a prompt in the reader's own coding agent, in one click.
 * The chevron picks another agent (remembered) or copies the prompt. Only once there is a report.
 */
export const handoffButton = (h: H, model: Model, investigation: V2Investigation): Html | null => {
	if (investigation.report === null) return null
	const input = handoffInputOf(model, investigation)
	const target = model.handoff.target
	const label = AGENT_TARGET_LABEL[target]
	return hstack(h, { align: "stretch" }, [
		linkButton(
			h,
			{
				variant: "outline",
				size: "sm",
				href: agentDeepLink(target, input),
				className: splitButtonClass("lead"),
				attributes: [
					h.AriaLabel(`Fix in ${label}`),
					h.Title(`Opens ${label} with the diagnosis filled in. Nothing runs until you send it.`),
				],
			},
			// A phone keeps "Fix" so the status actions still fit beside it.
			[
				icon(h, AGENT_ICON[target]),
				typography(h, { as: "span" }, [
					"Fix",
					typography(h, { as: "span", className: "max-sm:hidden" }, [` in ${label}`]),
				]),
			],
		),
		h.submodel({
			slotId: "investigation-handoff",
			model: model.handoffMenu,
			view: MenuView.view,
			viewInputs: {
				entries: [
					{ _tag: "Label", label: "Open the fix in" },
					...Arr.map(AGENT_TARGETS, (value): MenuView.MenuEntry => ({
						_tag: "Item",
						value,
						label: AGENT_TARGET_LABEL[value],
						icon: AGENT_ICON[value],
					})),
					{ _tag: "Separator" },
					{ _tag: "Item", value: "copy", label: "Copy prompt", icon: "CopyIcon" },
				],
				align: "end",
				className: "min-w-44",
				toView: ({ trigger, withTrigger }) =>
					h.span(
						[h.Class("contents")],
						withTrigger(
							button(
								h,
								{
									variant: "outline",
									size: "icon-sm",
									className: splitButtonClass("tail", "outline"),
									attributes: [h.AriaLabel("Choose a coding agent"), ...trigger],
								},
								[icon(h, "ChevronDownIcon", { className: "size-3.5" })],
							),
						),
					),
			},
			toParentMessage: (message) => Message.GotHandoffMenuMessage({ message }),
		}),
	])
}

/** One proposed action handed to the reader's agent, from the action sheet. */
export const focusedHandoffLink = (h: H, model: Model, actionText: string): Html | null =>
	Option.match(investigationOf(model), {
		onNone: () => null,
		onSome: (investigation) => {
			if (investigation.report === null) return null
			const target = model.handoff.target
			return linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					href: agentDeepLink(target, handoffInputOf(model, investigation, actionText)),
					className: "gap-1.5",
				},
				[icon(h, AGENT_ICON[target]), `Do this in ${AGENT_TARGET_LABEL[target]}`],
			)
		},
	})
