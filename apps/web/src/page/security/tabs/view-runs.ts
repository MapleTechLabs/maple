import type { SecurityAuditRun, SecurityAuditTarget } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import { formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import * as SelectView from "../../../ui/select-view"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { nothingInWindow } from "../../kit/nothing-in-window"
import { relativeTime } from "../../kit/relative-time"
import {
	formatElapsed,
	formatUsd,
	runTotalUsd,
	isLive,
	modelLabel,
	PROFILE_LABEL,
	RUN_KIND_LABEL,
	runElapsed,
	scopeLabel,
	shortId,
	refLabel,
} from "../kit/format"
import { placeholderRows, repositoryName, runStatusBadge } from "../kit/parts"
import { RUN_LIST_CAP, runsForTab, runsForTarget, targetsOf } from "./derive"
import { Message, type Model } from "./model"

// The Runs tab: every run, newest first, narrowed to one target from the select.

type H = HtmlBuilder<Message>

const runRow = (
	h: H,
	run: SecurityAuditRun,
	targets: ReadonlyArray<SecurityAuditTarget>,
	nowMs: number,
	timeZone: string,
): Html => {
	const href = hrefOf(AppRoute.SecurityRun({ runId: run.id }))
	const repository = targets.find((target) => target.id === run.targetId)?.repository ?? "Removed target"
	return tableRow(
		h,
		[
			tableCell(h, [
				h.a(
					[h.Href(href), h.Class("flex min-w-0 flex-col")],
					[
						h.span([h.Class("font-mono text-sm")], [`Run ${shortId(run.id)}`]),
						h.span(
							[h.Class("truncate text-xs text-muted-foreground")],
							[
								[
									RUN_KIND_LABEL[run.kind].toLowerCase(),
									PROFILE_LABEL[run.profile],
									scopeLabel(run.scopePaths),
								].join(" · "),
							],
						),
					],
				),
			]),
			tableCell(h, [
				h.span(
					[h.Class("flex min-w-0 flex-col")],
					[
						repositoryName(h, repository, "text-sm"),
						h.span(
							[h.Class("truncate font-mono text-xs text-muted-foreground")],
							[refLabel(run.sourceRef)],
						),
					],
				),
			]),
			tableCell(h, [runStatusBadge(h, run)]),
			tableCell(
				h,
				[run.discoveryModel === null ? "" : modelLabel(run.discoveryModel)],
				"truncate text-xs text-muted-foreground",
			),
			tableCell(
				h,
				[formatNumber(run.inputTokens + run.outputTokens)],
				"text-right font-mono tabular-nums",
			),
			tableCell(h, [formatUsd(runTotalUsd(run))], "text-right font-mono tabular-nums"),
			tableCell(
				h,
				[
					relativeTime(h, {
						value: run.startedAt,
						nowMs,
						timeZone,
						variant: "short",
						tooltip: "title",
					}),
				],
				"text-right font-mono text-xs text-muted-foreground",
			),
			tableCell(
				h,
				[formatElapsed(runElapsed(run, nowMs))],
				"text-right font-mono text-xs text-muted-foreground",
			),
		],
		undefined,
		[h.Key(run.id)],
	)
}

const toolbar = (
	h: H,
	model: Model,
	targets: ReadonlyArray<SecurityAuditTarget>,
	count: number,
	isCapped: boolean,
): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2 border-b border-border/60 px-2 py-1.5")],
		[
			h.submodel({
				slotId: model.runsTargetSelect.id,
				model: model.runsTargetSelect,
				view: SelectView.view,
				viewInputs: {
					entries: [
						{ _tag: "Item", item: { value: "all", label: "All targets" } },
						...targets.map((target): SelectView.SelectEntry => ({
							_tag: "Item",
							item: { value: target.id, label: target.repository },
						})),
					],
					size: "sm",
					ariaLabel: "Target",
					className: "h-7 w-auto min-w-40 text-xs",
					renderValue: (value) => [
						h.span([h.Class("text-muted-foreground")], ["Target "]),
						value === "all"
							? "All targets"
							: (targets.find((target) => target.id === value)?.repository ?? "Removed target"),
					],
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
				toParentMessage: (message) => Message.GotRunsTargetSelectMessage({ message }),
			}),
			h.span(
				[h.Class("ml-auto text-xs tabular-nums text-muted-foreground")],
				[
					isCapped
						? `showing the ${RUN_LIST_CAP} newest`
						: `${count} ${count === 1 ? "run" : "runs"}`,
				],
			),
		],
	)

/** "Start run" for the target the list is narrowed to. */
export const startRunAction = (h: H, model: Model): Html | undefined => {
	const targetId = model.runsSearch.target
	const target = targetsOf(model).find((candidate) => candidate.id === targetId)
	if (target === undefined || !model.isAdmin) return undefined
	const isRunning = runsForTarget(model, target.id).some(isLive)
	return button(
		h,
		{
			size: "sm",
			isDisabled: isRunning || model.startingTargetId !== null,
			attributes: [
				h.OnClick(Message.ClickedStartRun({ targetId: target.id })),
				...(isRunning ? [h.Title("One audit runs per target at a time")] : []),
			],
		},
		[icon(h, "MediaPlayIcon"), model.startingTargetId === target.id ? "Starting..." : "Start run"],
	)
}

/** No target yet: the way to add one, or to the overview for a member who cannot. */
const noTargets = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyTitle(h, ["No runs yet"]),
				emptyDescription(h, [
					model.isAdmin
						? "Add a target, then start its first run."
						: "An org admin adds the first target on the Overview tab.",
				]),
			]),
			model.isAdmin
				? button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedAddTarget())] }, [
						icon(h, "PlusIcon"),
						"Add target",
					])
				: linkButton(h, { size: "sm", variant: "outline", href: hrefOf(AppRoute.Security()) }, [
						"Open the overview",
					]),
		],
		"rounded-md border border-dashed md:py-14",
	)

export const runsBody = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const targets = targetsOf(model)
	const { runs, isCapped } = runsForTab(model)
	const content = AsyncData.matchData(model.runs.data, {
		onEmpty: () => placeholderRows(h, 6),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load runs",
				variant: "inline",
				onRetry: Message.ClickedRetry(),
			}),
		onData: () =>
			runs.length === 0
				? h.div(
						[h.Class("p-4")],
						[
							targets.length === 0
								? noTargets(h, model)
								: nothingInWindow(h, {
										title: "No runs yet",
										description:
											"Runs start manually for now: pick a target and start one.",
									}),
						],
					)
				: table(h, { variant: "bare", ariaLabel: "Audit runs" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Run"]),
								tableHead(h, ["Target"]),
								tableHead(h, ["Status"]),
								tableHead(h, ["Model"]),
								tableHead(h, ["Tokens"], "text-right"),
								tableHead(h, ["Cost"], "text-right"),
								tableHead(h, ["Started"], "text-right"),
								tableHead(h, ["Duration"], "text-right"),
							]),
						]),
						tableBody(
							h,
							runs.map((run) => runRow(h, run, targets, model.nowMs, timeZone)),
						),
					]),
	})
	return [
		h.section(
			[h.AriaLabel("Runs"), h.Class("overflow-hidden rounded-md border bg-card")],
			// Nothing to narrow until there is a target, as on the Findings tab.
			[...(targets.length === 0 ? [] : [toolbar(h, model, targets, runs.length, isCapped)]), content],
		),
	]
}
