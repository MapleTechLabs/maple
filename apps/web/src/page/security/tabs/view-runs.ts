import type { SecurityAuditRun, SecurityAuditRunDetail, SecurityAuditTarget } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import { countLabel } from "@maple/ui/lib/format"
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
	isCancelled,
	isLive,
	PROFILE_LABEL,
	RUN_KIND_LABEL,
	runElapsed,
	scopeLabel,
	shortId,
	refLabel,
	runToneOf,
} from "../kit/format"
import { placeholderRows, repositoryName, runStatusBadge } from "../kit/parts"
import {
	coverageOf,
	latestDetailOf,
	RUN_LIST_CAP,
	runCountsOf,
	runsForTab,
	runsForTarget,
	targetsOf,
} from "./derive"
import { stopSummaryOf } from "../kit/outcome"
import { BUCKET_LABEL, type BucketCounts, SCORED_BUCKETS } from "../kit/findings"
import { bucketDot } from "../kit/findings-view"
import { meter } from "../../../ui/meter"
import { Message, type Model } from "./model"
import { listToolbar, toolbarCount } from "../../kit/list-toolbar"

// The Runs tab: every run, newest first, narrowed to one target from the select.

type H = HtmlBuilder<Message>

/** The status, and for a run that stopped short, why in one line. */
const statusCell = (h: H, run: SecurityAuditRun): Html => {
	const reason =
		isLive(run) || run.status === "complete" || isCancelled(run)
			? null
			: run.status === "failed"
				? (run.error ?? "could not finish")
				: stopSummaryOf(run.incompleteReason)
	return h.div(
		[h.Class("flex min-w-0 flex-col items-start gap-1")],
		[
			runStatusBadge(h, run),
			...(reason === null
				? []
				: [
						h.span(
							[h.Class("max-w-48 truncate text-xs text-muted-foreground"), h.Title(reason)],
							[reason],
						),
					]),
		],
	)
}

const muted = (h: H, text: string, title?: string): Html =>
	h.span(
		[h.Class("text-xs text-muted-foreground"), ...(title === undefined ? [] : [h.Title(title)])],
		[text],
	)

/** One dot and count per non-empty severity, so two runs compare at a glance. */
const findingsCell = (
	h: H,
	counts: Readonly<{ buckets: BucketCounts; unverified: number }> | null,
	run: SecurityAuditRun,
): Html => {
	if (counts === null) return muted(h, "", "Findings are visible to org admins only")
	const { buckets, unverified } = counts
	const shown = SCORED_BUCKETS.filter((bucket) => buckets[bucket] > 0)
	if (shown.length === 0) return muted(h, isLive(run) ? "" : "None")
	return h.span(
		[
			h.Class("flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1"),
			h.Title(
				[
					...shown.map((bucket) => `${buckets[bucket]} ${BUCKET_LABEL[bucket].toLowerCase()}`),
					...(unverified === 0 ? [] : [`${unverified} of them estimated, not yet proven`]),
				].join(", "),
			),
		],
		shown.map((bucket) =>
			h.span(
				[h.Key(bucket), h.Class("inline-flex items-center gap-1 font-mono text-xs tabular-nums")],
				[bucketDot(h, bucket, "size-2"), String(buckets[bucket])],
			),
		),
	)
}

const coverageCell = (h: H, run: SecurityAuditRun, detail: SecurityAuditRunDetail | null): Html => {
	if (detail === null || detail.unitTotal === 0) return muted(h, "")
	const { closed, total } = coverageOf(detail)
	return h.div(
		[h.Class("flex items-center justify-end gap-2")],
		[
			meter(h, {
				value: closed,
				max: total,
				tone: runToneOf(run),
				className: "w-10",
				label: `${closed} of ${total} units closed`,
			}),
			h.span(
				[h.Class("whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground")],
				[`${closed} / ${total}`],
			),
		],
	)
}

const runRow = (
	h: H,
	model: Model,
	run: SecurityAuditRun,
	targets: ReadonlyArray<SecurityAuditTarget>,
	timeZone: string,
): Html => {
	const nowMs = model.nowMs
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
			tableCell(h, [statusCell(h, run)]),
			tableCell(h, [findingsCell(h, runCountsOf(model, run.id), run)], "text-right"),
			tableCell(h, [coverageCell(h, run, latestDetailOf(model, run.id))], "text-right"),
			tableCell(h, [formatUsd(runTotalUsd(run))], "text-right font-mono tabular-nums"),
			tableCell(
				h,
				[
					h.span(
						[h.Class("flex flex-col items-end")],
						[
							relativeTime(h, {
								value: run.startedAt,
								nowMs,
								timeZone,
								variant: "short",
								tooltip: "title",
							}),
							h.span([h.Title("Duration")], [formatElapsed(runElapsed(run, nowMs))]),
						],
					),
				],
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
	listToolbar(h, {
		framed: true,
		leading: h.submodel({
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
		trailing: [
			toolbarCount(h, [isCapped ? `showing the ${RUN_LIST_CAP} newest` : countLabel(count, "run")]),
		],
	})

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
			isLoading: model.startingTargetId === target.id,
			isDisabled: isRunning || model.startingTargetId !== null,
			attributes: [
				h.OnClick(Message.ClickedStartRun({ targetId: target.id })),
				...(isRunning ? [h.Title("One audit runs per target at a time")] : []),
			],
		},
		[icon(h, "MediaPlayIcon"), "Start run"],
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
				: linkButton(h, { size: "sm", variant: "outline", href: hrefOf(AppRoute.SecurityCode()) }, [
						"Open the overview",
					]),
		],
		"rounded-md border border-dashed md:py-14",
	)

export const runsBody = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	// A failed load drops the table frame and draws the same error block as Overview and Findings.
	if (model.runs.data._tag === "Failure")
		return [
			errorState(h, {
				failure: model.runs.data.error,
				title: "Couldn't load runs",
				onRetry: Message.ClickedRetry(),
			}),
		]
	const targets = targetsOf(model)
	const { runs, isCapped } = runsForTab(model)
	const content = AsyncData.matchData(model.runs.data, {
		onEmpty: () => placeholderRows(h, 6),
		onFailure: () => h.div([], []),
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
								tableHead(h, ["Findings"], "text-right"),
								tableHead(h, ["Coverage"], "text-right"),
								tableHead(h, ["Cost"], "text-right"),
								tableHead(h, ["Started"], "text-right"),
							]),
						]),
						tableBody(
							h,
							runs.map((run) => runRow(h, model, run, targets, timeZone)),
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
