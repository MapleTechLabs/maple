import type { AnomalyIncidentDocument, ErrorIssueDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import { commandEmptyStyles, commandItemStyles, commandListStyles } from "@maple/ui/styles/ui/command"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "../../../ui/combobox"
import { textLink } from "../../../ui/text-link"
import { commandHiddenInput, commandInput } from "../../../ui/command"
import { view as dialogView } from "../../../ui/dialog-view"
import { scrollArea } from "../../../ui/scroll-area"
import { spinner } from "../../../ui/spinner"
import { relativeTime } from "../../kit/relative-time"
import { workflowRingIcon } from "../../errors/kit/workflow"
import { shortIssueId } from "../kit/row"
import { Message } from "./message"
import type { Model } from "./model"

// `AnomalyLinkIssueDialog`: a command
// dialog over the service's issues, filtered here (`filter={null}`), the linked one left out.

type H = HtmlBuilder<Message>

const toCombobox = (message: Combobox.Message) => Message.GotLinkComboboxMessage({ message })

const filteredOf = (model: Model, incident: AnomalyIncidentDocument): ReadonlyArray<ErrorIssueDocument> => {
	const issues = AsyncData.getOrElse(model.linkIssues.data, () => []).map(errorIssueFromV2)
	const q = model.linkCombobox.inputValue.trim().toLowerCase()
	const matches =
		q.length === 0
			? issues
			: issues.filter(
					(issue) =>
						issue.exceptionType.toLowerCase().includes(q) ||
						issue.exceptionMessage.toLowerCase().includes(q) ||
						issue.serviceName.toLowerCase().includes(q) ||
						shortIssueId(issue.id).toLowerCase().includes(q),
				)
	return matches.filter((issue) => issue.id !== incident.errorIssueId)
}

const item = (h: H, model: Model, issue: ErrorIssueDocument, index: number, timeZone: string): Html =>
	h.div(
		[
			h.Key(issue.id),
			h.Class(cn(A.autocompleteItemStyles, commandItemStyles)),
			...(model.linkCombobox.highlighted === index ? [h.DataAttribute("highlighted", "")] : []),
			h.DataAttribute("slot", "command-item"),
			h.Id(Combobox.itemId(model.linkCombobox.id, index)),
			h.Role("option"),
			h.OnMouseMove(toCombobox(Combobox.Message.HighlightedItem({ index }))),
			h.OnClick(Message.SelectedLinkIssue({ issueId: issue.id })),
		],
		[
			h.span(
				[h.Class("flex min-w-0 flex-1 items-center gap-2")],
				[
					workflowRingIcon(h, issue.workflowState, 14),
					h.span([h.Class("truncate text-foreground")], [issue.exceptionType || "Unknown error"]),
					...(issue.exceptionMessage
						? [h.span([h.Class("truncate text-muted-foreground")], [issue.exceptionMessage])]
						: []),
				],
			),
			h.span(
				[h.Class("ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground")],
				[
					h.code([h.Class("font-mono tabular-nums")], [shortIssueId(issue.id)]),
					relativeTime(h, {
						value: issue.lastSeenAt,
						nowMs: model.nowMs,
						timeZone,
						tooltip: "title",
						className: "tabular-nums",
					}),
				],
			),
		],
	)

const listBody = (
	h: H,
	model: Model,
	incident: AnomalyIncidentDocument,
	timeZone: string,
): ReadonlyArray<Html> => {
	const query = model.linkCombobox.inputValue
	if (AsyncData.isLoading(model.linkIssues.data) || AsyncData.isIdle(model.linkIssues.data))
		return [
			h.div(
				[h.Class("flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground")],
				[spinner(h, "size-3.5"), " Loading issues…"],
			),
		]
	const filtered = filteredOf(model, incident)
	if (filtered.length === 0)
		return [
			h.div(
				[
					h.AriaAtomic(true),
					h.AriaLive("polite"),
					h.Class(cn(A.autocompleteEmptyStyles, commandEmptyStyles)),
					h.DataAttribute("slot", "command-empty"),
					h.Role("status"),
				],
				[
					query.length > 0
						? `No issues matching “${query}”`
						: model.linkAllServices
							? "No issues found"
							: `No issues for ${incident.serviceName}`,
				],
			),
		]
	const labelId = `${model.linkCombobox.id}-group-0`
	return [
		h.div(
			[
				h.AriaLabelledBy(labelId),
				h.Class(cn(A.autocompleteGroupStyles)),
				h.DataAttribute("slot", "command-group"),
				h.Role("group"),
			],
			[
				h.div(
					[
						h.AriaHidden(true),
						h.Class(cn(A.autocompleteGroupLabelStyles)),
						h.DataAttribute("slot", "command-group-label"),
						h.Id(labelId),
					],
					[model.linkAllServices ? "All services" : incident.serviceName],
				),
				...filtered.map((issue, index) => item(h, model, issue, index, timeZone)),
			],
		),
	]
}

export const linkIssueDialog = (
	h: H,
	model: Model,
	incident: AnomalyIncidentDocument,
	timeZone: string,
): Html =>
	h.submodel({
		slotId: "anomaly-link-issue-dialog",
		model: model.linkDialog,
		view: dialogView,
		viewInputs: {
			hasTrigger: false,
			// The dialog has no trigger: closing leaves focus on the body.
			isReturningFocus: false,
			toView: ({ portal }) => portal,
			toContent: () =>
				model.linkDialog.isOpen
					? [
							commandInput(
								h,
								model.linkCombobox,
								{
									hasDismissButton: true,
									isUnfiltered: true,
									placeholder: `Search issues${model.linkAllServices ? "" : ` in ${incident.serviceName}`}…`,
									groups: [
										{
											label: "",
											items: filteredOf(model, incident).map((issue) => ({
												title: String(issue.id),
											})),
										},
									],
								},
								toCombobox,
							),
							scrollArea(
								h,
								{
									idPrefix: `${model.linkCombobox.id}-scroll`,
									scrollFade: true,
									scrollbarGutter: true,
								},
								[
									h.div(
										[
											h.Class(cn(A.autocompleteListStyles, commandListStyles)),
											h.DataAttribute("empty", ""),
											h.DataAttribute("slot", "command-list"),
											h.Id(Combobox.listId(model.linkCombobox.id)),
											h.Role("listbox"),
											h.Tabindex(-1),
										],
										listBody(h, model, incident, timeZone),
									),
								],
							),
							h.div(
								[
									h.Class(
										"flex items-center justify-between border-t border-border-subtle px-3 py-2",
									),
								],
								[
									h.span(
										[h.Class("text-xs text-muted-foreground")],
										[
											model.linkAllServices
												? "Showing issues across all services"
												: `Scoped to ${incident.serviceName}`,
										],
									),
									textLink(
										h,
										{ className: "text-xs", onClick: Message.ToggledLinkScope() },
										[
											model.linkAllServices
												? `Only ${incident.serviceName}`
												: "Search all services",
										],
									),
								],
							),
							commandHiddenInput(h, model.linkCombobox),
						]
					: [],
		},
		toParentMessage: (message) => Message.GotLinkDialogMessage({ message }),
	})
