import type { ErrorIssueDocument } from "@maple/domain/http"
import { agentPromptFromIssue } from "../../../components/errors/agent-debug-prompt"
import { AlertRuleId } from "@maple/domain/primitives"
import { Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import * as Menu from "../../../ui/menu"
import type { MenuEntry } from "../../../ui/menu-view"
import { PageOutMessage, type PageReturn } from "../../contract"
import { CopyText } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

// The issue overflow menu: copies, and the alert rule for alert issues.

const decodeRuleId = Schema.decodeUnknownOption(AlertRuleId)
const ruleIdOf = (issue: ErrorIssueDocument) => Option.getOrNull(decodeRuleId(issue.sourceRef?.ruleId))

export const overflowEntries = (issue: ErrorIssueDocument): ReadonlyArray<MenuEntry> => [
	...(issue.kind === "error"
		? [{ _tag: "Item" as const, value: "prompt", label: "Copy agent prompt", icon: "CopyIcon" as const }]
		: []),
	...(issue.fingerprintHash
		? [
				{
					_tag: "Item" as const,
					value: "fingerprint",
					label: "Copy fingerprint",
					icon: "CopyIcon" as const,
				},
			]
		: []),
	{ _tag: "Item", value: "link", label: "Copy link to issue", icon: "LinkIcon" },
	...(ruleIdOf(issue) === null
		? []
		: [{ _tag: "Item" as const, value: "rule", label: "View alert rule", icon: "PulseIcon" as const }]),
]

type Return = PageReturn<Model, Message>

const picked = (model: Model, issue: ErrorIssueDocument, value: string): Return => {
	switch (value) {
		case "prompt":
			return {
				model,
				commands: [
					CopyText({ label: "Agent prompt", text: agentPromptFromIssue(issue), isPath: false }),
				],
			}
		case "fingerprint":
			return {
				model,
				commands: [CopyText({ label: "Fingerprint", text: issue.fingerprintHash, isPath: false })],
			}
		case "link":
			return {
				model,
				commands: [
					CopyText({ label: "Issue link", text: `/errors/issues/${issue.id}`, isPath: true }),
				],
			}
		case "rule": {
			const ruleId = ruleIdOf(issue)
			return ruleId === null
				? { model }
				: {
						model,
						outMessage: PageOutMessage.RequestedNavigation({
							url: hrefOf(AppRoute.AlertRule({ ruleId, search: {} })),
							isReplace: false,
						}),
					}
		}
		default:
			return { model }
	}
}

export const overflowStep = (
	model: Model,
	issue: ErrorIssueDocument | null,
	message: Menu.Message,
): Return => {
	const next: Update.ReturnWithOutMessage<Menu.Model, Menu.Message, Menu.OutMessage> = Menu.update(
		model.overflowMenu,
		message,
	)
	const lifted = {
		model: { ...model, overflowMenu: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotOverflowMenuMessage({ message: inner }),
		),
	}
	if (next.outMessage?._tag !== "SelectedItem" || issue === null) return lifted
	const step = picked(lifted.model, issue, next.outMessage.value)
	return { ...step, commands: [...lifted.commands, ...(step.commands ?? [])] }
}
