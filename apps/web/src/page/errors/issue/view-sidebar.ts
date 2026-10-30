import {
	allowedTransitionsForAll,
	type ErrorIssueDocument,
	type ErrorIssueEnvironment,
	type IssueSeveritySource,
	MACHINE_OWNED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
	type WorkflowState,
} from "@maple/domain/http"
import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { detailRailField, detailRailGroup, detailRailRow } from "../../../ui/detail-rail"
import * as SelectView from "../../../ui/select-view"
import { serviceDot } from "../../../ui/values"
import { actorChip } from "../kit/actor"
import { clampPriority, PRIORITY_LABEL, priorityBarsIcon } from "../kit/priority"
import { SEVERITY_LABEL, SEVERITY_ORDER, severityDot } from "../kit/severity"
import { WORKFLOW_LABEL, workflowRingIcon } from "../kit/workflow"
import { Message } from "./message"
import { leaseHud } from "./view-lease"
import type { Model } from "./model"
import { sidebarBusy } from "./writes"

// The issue sidebar with its state and severity selects.
// TODO(lease): a held lease should render the lease HUD with Extend and Release; Claim is inert here.

type H = HtmlBuilder<Message>

const GHOST_TRIGGER = cn(
	"-mr-1.5 h-7 min-h-0 w-auto min-w-0 max-w-full gap-1.5 px-1.5 text-sm font-medium",
	"border-transparent bg-transparent shadow-none before:hidden dark:bg-transparent",
	"hover:bg-surface-strong data-popup-open:bg-surface-strong",
)

const SEVERITY_SOURCE_HINT = {
	detector: "by detector",
	ai: "by AI triage",
	manual: "set by hand",
} satisfies Record<IssueSeveritySource, string>

const OFFERED_STATES = WORKFLOW_STATE_ORDER.filter((state) => !MACHINE_OWNED_WORKFLOW_STATES.has(state))

const isWorkflowState = (value: string): value is WorkflowState =>
	WORKFLOW_STATE_ORDER.some((state) => state === value)
const isSeverity = (value: string) => SEVERITY_ORDER.find((severity) => severity === value) ?? null

/** Unreachable states stay listed but disabled, so the list reads the same from every state. */
const stateEntries = (current: WorkflowState): ReadonlyArray<SelectView.SelectEntry> => {
	const allowed = new Set<WorkflowState>(allowedTransitionsForAll([current]))
	return OFFERED_STATES.map((state) => ({
		_tag: "Item",
		item: {
			value: state,
			label: WORKFLOW_LABEL[state],
			isDisabled: state !== current && !allowed.has(state),
		},
	}))
}

const SEVERITY_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = [
	...SEVERITY_ORDER.map((severity) => ({
		_tag: "Item" as const,
		item: { value: severity, label: SEVERITY_LABEL[severity] },
	})),
	{ _tag: "Item", item: { value: "none", label: "Not set" } },
]

const withIcon = (h: H, mark: Html, label: string): ReadonlyArray<Html> => [
	h.span([h.Class("flex items-center gap-2")], [mark, label]),
]

const stateSelect = (h: H, model: Model, current: WorkflowState): Html =>
	h.submodel({
		slotId: model.statusSelect.id,
		model: model.statusSelect,
		view: SelectView.view,
		viewInputs: {
			entries: stateEntries(current),
			className: GHOST_TRIGGER,
			isDisabled: sidebarBusy(model) === "state",
			renderValue: (value) =>
				isWorkflowState(value)
					? withIcon(h, workflowRingIcon(h, value, 12), WORKFLOW_LABEL[value])
					: ["State"],
			renderItem: (option) =>
				isWorkflowState(option.value)
					? [
							h.span(
								[h.Class("flex items-center gap-2")],
								[
									workflowRingIcon(h, option.value),
									option.label,
									...(option.value === current ? [" (current)"] : []),
								],
							),
						]
					: [option.label],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
		toParentMessage: (message) => Message.GotStatusSelectMessage({ message }),
	})

const severitySelect = (h: H, model: Model): Html =>
	h.submodel({
		slotId: model.severitySelect.id,
		model: model.severitySelect,
		view: SelectView.view,
		viewInputs: {
			entries: SEVERITY_ENTRIES,
			ariaLabel: "Severity",
			className: GHOST_TRIGGER,
			isDisabled: sidebarBusy(model) === "severity",
			renderValue: (value) => {
				const severity = isSeverity(value)
				return withIcon(
					h,
					severityDot(h, severity),
					severity === null ? "Not set" : SEVERITY_LABEL[severity],
				)
			},
			renderItem: (option) => withIcon(h, severityDot(h, isSeverity(option.value)), option.label),
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
		toParentMessage: (message) => Message.GotSeveritySelectMessage({ message }),
	})

const ENVIRONMENT_ROWS_SHOWN = 4

const environmentValue = (h: H, environments: ReadonlyArray<ErrorIssueEnvironment>): Html => {
	if (environments.length === 0) return h.span([h.Class("text-xs text-muted-foreground")], [EMPTY_VALUE])
	const shown = environments.slice(0, ENVIRONMENT_ROWS_SHOWN)
	const hidden = environments.length - shown.length
	return h.ul(
		[h.Class("flex w-full min-w-0 flex-col items-stretch gap-0.5")],
		[
			...shown.map((env) =>
				h.li(
					[h.Class("flex min-w-0 items-baseline justify-between gap-3")],
					[
						h.span([h.Class("truncate text-sm text-foreground")], [env.name]),
						h.span(
							[h.Class("shrink-0 font-mono text-2xs tabular-nums text-muted-foreground")],
							[formatNumber(env.count)],
						),
					],
				),
			),
			...(hidden > 0
				? [h.li([h.Class("text-right text-2xs text-muted-foreground")], [`+${hidden} more`])]
				: []),
		],
	)
}

/** `shortIssueId`: the first seven hex digits, upper case. */
const shortIssueId = (id: string): string => id.replace(/-/g, "").slice(0, 7).toUpperCase()

/** `IssueIdCopy`: the short id that copies the full one. TODO(tooltip): its "Copy issue ID" popup. */
const issueIdCopy = (h: H, model: Model, id: string): Html =>
	button(
		h,
		{
			variant: "ghost",
			size: "xs",
			slot: "tooltip-trigger",
			className:
				"group/copy -mr-1.5 px-1.5 font-mono tabular-nums text-muted-foreground hover:text-foreground",
			attributes: [
				h.OnClick(
					Message.GotIssueIdCopyMessage({ message: CopyButton.Message.ClickedCopy({ text: id }) }),
				),
				h.DataAttribute("base-ui-tooltip-trigger", ""),
			],
		},
		[
			shortIssueId(id),
			CopyButton.copyIndicator(h, {
				status: model.issueIdCopy.status,
				iconSize: 12,
				className:
					"opacity-0 transition-opacity group-hover/copy:opacity-100 data-[copy-status=copied]:opacity-100 pointer-coarse:opacity-100",
			}),
		],
	)

/** A held lease: the HUD with Extend and Release; otherwise Claim, or nothing on a closed issue. */
const leaseGroup = (h: H, model: Model, issue: ErrorIssueDocument, canClaim: boolean): Html => {
	const hud =
		issue.leaseHolder !== null && issue.leaseExpiresAt !== null
			? leaseHud(
					h,
					{
						leaseHolder: issue.leaseHolder,
						leaseExpiresAt: issue.leaseExpiresAt,
						claimedAt: issue.claimedAt,
					},
					model.leaseNowMs === 0 ? model.nowMs : model.leaseNowMs,
				)
			: undefined
	if (hud !== undefined)
		return h.div(
			[h.Class("flex flex-col gap-2")],
			[
				...(hud === null ? [] : [hud]),
				h.div(
					[h.Class("flex justify-end gap-1")],
					[
						button(
							h,
							{
								size: "xs",
								variant: "ghost",
								isLoading: sidebarBusy(model) === "heartbeat",
								attributes: [h.OnClick(Message.ClickedExtendLease())],
							},
							["Extend"],
						),
						button(
							h,
							{
								size: "xs",
								variant: "ghost",
								isLoading: sidebarBusy(model) === "release",
								attributes: [h.OnClick(Message.ClickedReleaseLease())],
							},
							["Release"],
						),
					],
				),
			],
		)
	return detailRailRow(h, { label: canClaim ? "Unclaimed" : "Closed" }, [
		canClaim
			? button(
					h,
					{
						size: "xs",
						variant: "outline",
						className: "-mr-0.5",
						isLoading: sidebarBusy(model) === "claim",
						attributes: [h.OnClick(Message.ClickedClaim())],
					},
					["Claim"],
				)
			: h.span([h.Class("text-xs text-muted-foreground")], ["No lease needed"]),
	])
}

export const issueSidebar = (
	h: H,
	model: Model,
	issue: ErrorIssueDocument,
	environments: ReadonlyArray<ErrorIssueEnvironment>,
): Html => {
	const priority = clampPriority(issue.priority)
	const isTerminal = issue.workflowState === "cancelled" || issue.workflowState === "done"
	const canClaim = issue.leaseHolder === null && !isTerminal
	return h.div(
		[h.Class("flex flex-col bg-card/30")],
		[
			detailRailGroup(h, "Details", [
				detailRailRow(h, { label: "Status" }, [stateSelect(h, model, issue.workflowState)]),
				detailRailRow(
					h,
					{
						label: "Severity",
						hint: issue.severitySource ? SEVERITY_SOURCE_HINT[issue.severitySource] : undefined,
					},
					[severitySelect(h, model)],
				),
				detailRailRow(h, { label: "Priority" }, [
					h.span(
						[h.Class("flex items-center gap-2")],
						[
							priorityBarsIcon(h, priority, 12),
							h.span([h.Class("text-sm text-foreground")], [PRIORITY_LABEL[priority]]),
						],
					),
				]),
				detailRailRow(h, { label: "Assignee" }, [actorChip(h, issue.assignedActor)]),
			]),
			detailRailGroup(h, "Scope", [
				detailRailField(h, { label: "Service", title: issue.serviceName }, [
					h.span(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							serviceDot(h, { serviceName: issue.serviceName, size: "sm" }),
							h.span([h.Class("truncate text-sm text-foreground")], [issue.serviceName]),
						],
					),
				]),
				detailRailField(
					h,
					{
						label: "Environment",
						hint: environments.length > 0 ? "in this window" : undefined,
						title: environments
							.map((env) => `${env.name} · ${env.count.toLocaleString("en-US")}`)
							.join("\n"),
					},
					[environmentValue(h, environments)],
				),
				...(issue.resolvedVersions.length > 0
					? [
							detailRailRow(
								h,
								{ label: "Resolved in", title: issue.resolvedVersions.join(", ") },
								[
									h.span(
										[h.Class("truncate font-mono text-xs text-foreground")],
										[issue.resolvedVersions.join(", ")],
									),
								],
							),
						]
					: []),
				detailRailRow(h, { label: "Issue ID" }, [issueIdCopy(h, model, issue.id)]),
			]),
			detailRailGroup(h, "Lease", [leaseGroup(h, model, issue, canClaim)]),
		],
	)
}
