import { allowedTransitionsForAll, type ErrorIssueDocument, type WorkflowState } from "@maple/domain/http"
import { agentPromptFromIssue } from "../../../components/errors/agent-debug-prompt"
import { Command, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import * as ContextMenu from "../../../ui/context-menu"
import type * as ContextMenuView from "../../../ui/context-menu-view"
import { icon } from "../../../ui/icon"
import type { PageReturn } from "../../contract"
import { WORKFLOW_LABEL, workflowRingIcon } from "../kit/workflow"
import { CopyRowText, OpenInNewTab } from "./command"
import { signalsOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { startHubWrite } from "./selection"

// The issue context menu: a row's right-click menu.

type Return = PageReturn<Model, Message>

/** What each top-level entry does, in entry order (the submenu and separator do nothing themselves). */
type Action = "submenu" | "separator" | "claim" | "release" | "open" | "copy-link" | "copy-id" | "copy-prompt"

const actionsOf = (issue: ErrorIssueDocument): ReadonlyArray<Action> => [
	"submenu",
	...(issue.leaseHolder === null ? ["claim" as const] : ["release" as const]),
	"separator",
	"open",
	"copy-link",
	"copy-id",
	...(issue.kind === "error" ? ["copy-prompt" as const] : []),
]

const LABEL = {
	claim: "Claim",
	release: "Release",
	open: "Open in new tab",
	"copy-link": "Copy link",
	"copy-id": "Copy ID",
	"copy-prompt": "Copy agent prompt",
} satisfies Record<Exclude<Action, "submenu" | "separator">, string>

const targetsOf = (issue: ErrorIssueDocument): ReadonlyArray<WorkflowState> =>
	allowedTransitionsForAll([issue.workflowState])

export const rowMenuEntries = <M>(
	h: HtmlBuilder<M>,
	issue: ErrorIssueDocument,
): ReadonlyArray<ContextMenuView.Entry> => {
	const targets = targetsOf(issue)
	const current = issue.workflowState
	return actionsOf(issue).map((action): ContextMenuView.Entry => {
		switch (action) {
			case "separator":
				return { _tag: "Separator" }
			case "submenu":
				return {
					_tag: "Submenu",
					content: [workflowRingIcon(h, current), h.span([], ["Change status"])],
					className: "w-56 p-1",
					entries: [
						{
							_tag: "Item",
							label: WORKFLOW_LABEL[current],
							isDisabled: true,
							content: [
								workflowRingIcon(h, current),
								h.span([h.Class("flex-1")], [WORKFLOW_LABEL[current]]),
								icon(h, "CheckIcon", { className: "text-muted-foreground" }),
							],
						},
						...(targets.length === 0
							? [
									{
										_tag: "Item" as const,
										label: `No moves from ${WORKFLOW_LABEL[current]}`,
										isDisabled: true,
										content: [
											h.span(
												[h.Class("flex-1")],
												["No moves from ", WORKFLOW_LABEL[current]],
											),
										],
									},
								]
							: targets.map((state) => ({
									_tag: "Item" as const,
									label: WORKFLOW_LABEL[state],
									content: [
										workflowRingIcon(h, state),
										h.span([h.Class("flex-1")], [WORKFLOW_LABEL[state]]),
									],
								}))),
					],
				}
			default:
				return { _tag: "Item", label: LABEL[action] }
		}
	})
}

const issueOf = (model: Model, id: string) =>
	signalsOf(model).find((signal) => signal.id === id)?.issue ?? null

/** A right-press on a row: the menu moves to that row, opened at the pointer. */
export const pressedRowPointer = (model: Model, id: string, point: ContextMenu.Point): Return => ({
	model: {
		...model,
		rowMenuTarget: id,
		rowMenu:
			model.rowMenuTarget === id
				? { ...model.rowMenu, point }
				: ContextMenu.init(`errors-row-menu-${id}`, { point }),
	},
})

export const rowMenuStep = (model: Model, message: ContextMenu.Message): Return => {
	const next: Update.ReturnWithOutMessage<ContextMenu.Model, ContextMenu.Message, ContextMenu.OutMessage> =
		ContextMenu.update(model.rowMenu, message)
	const lifted = {
		model: { ...model, rowMenu: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotRowMenuMessage({ message: inner }),
		),
	}
	const target = model.rowMenuTarget
	const issue = target === null ? null : issueOf(model, target)
	if (next.outMessage === undefined || issue === null) return lifted
	const done = (step: Return): Return => ({
		...step,
		commands: [...lifted.commands, ...(step.commands ?? [])],
	})
	if (next.outMessage._tag === "SelectedSubItem") {
		// The first row is the current state, disabled; moves follow it.
		const toState = targetsOf(issue)[next.outMessage.index - 1]
		return toState === undefined
			? lifted
			: done(startHubWrite(lifted.model, [issue.id], { _tag: "Transition", toState }, false))
	}
	const href = `/errors/issues/${issue.id}`
	switch (actionsOf(issue)[next.outMessage.index]) {
		case "claim":
			return done(startHubWrite(lifted.model, [issue.id], { _tag: "Claim" }, false))
		case "release":
			return done(startHubWrite(lifted.model, [issue.id], { _tag: "Release" }, false))
		case "open":
			return done({ model: lifted.model, commands: [OpenInNewTab({ path: href })] })
		case "copy-link":
			return done({
				model: lifted.model,
				commands: [CopyRowText({ label: "Link", text: href, isPath: true })],
			})
		case "copy-id":
			return done({
				model: lifted.model,
				commands: [CopyRowText({ label: "Issue ID", text: issue.id, isPath: false })],
			})
		case "copy-prompt":
			return done({
				model: lifted.model,
				commands: [
					CopyRowText({ label: "Agent prompt", text: agentPromptFromIssue(issue), isPath: false }),
				],
			})
		default:
			return lifted
	}
}
