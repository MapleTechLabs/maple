import type { SecurityAuditRun, SecurityAuditRunDetail, SecurityAuditTarget } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ROOMY_COLUMN, WIDE_COLUMN } from "../kit/layout"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "@maple/views/ui/button"
import { empty, emptyDescription, emptyFrameClass, emptyHeader, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import * as SelectView from "@maple/views/ui/select-view"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { listRelativeTime } from "../../kit/relative-time"
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
	repositoryOf,
	runCountsOf,
	runsForTab,
	runsForTarget,
	targetsOf,
} from "./derive"
import { stopSummaryOf } from "../kit/outcome"
import { BUCKET_LABEL, type BucketCounts, SCORED_BUCKETS } from "../kit/findings"
import { bucketDot } from "../kit/findings-view"
import { meter } from "@maple/views/ui/meter"
import { canManage, Message, type Model } from "./model"
import { listToolbar, toolbarCount } from "../../kit/list-toolbar"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { Array as Arr, String as Str, Option } from "effect"

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
	return vstack(h, { gap: "1", align: "start", shrink: true }, [
		runStatusBadge(h, run),
		...(reason === null
			? []
			: [
					h.span(
						[h.Class("max-w-48 truncate text-xs text-muted-foreground"), h.Title(reason)],
						[reason],
					),
				]),
	])
}

const muted = (h: H, text: string, title?: string): Html =>
	h.span(
		[
			h.Class(typographyClass({ size: "xs", tone: "muted" })),
			...(title === undefined ? [] : [h.Title(title)]),
		],
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
	const shown = Arr.filter(SCORED_BUCKETS, (bucket) => buckets[bucket] > 0)
	if (shown.length === 0) return muted(h, isLive(run) ? "" : "None")
	return h.span(
		[
			h.Class("flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1"),
			h.Title(
				Arr.join(
					[
						...Arr.map(
							shown,
							(bucket) => `${buckets[bucket]} ${Str.toLowerCase(BUCKET_LABEL[bucket])}`,
						),
						...(unverified === 0 ? [] : [`${unverified} of them estimated, not yet proven`]),
					],
					", ",
				),
			),
		],
		Arr.map(shown, (bucket) =>
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
	return hstack(h, { gap: "2", justify: "end" }, [
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
	])
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
	const repository = repositoryOf(targets, run.targetId)
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.a(
						[h.Href(href), h.Class(vstackClass({ shrink: true }))],
						[
							typography(h, { size: "sm", mono: true }, [`Run ${shortId(run.id)}`]),
							typography(h, { size: "xs", tone: "muted", truncate: true }, [
								Arr.join(
									[
										Str.toLowerCase(RUN_KIND_LABEL[run.kind]),
										PROFILE_LABEL[run.profile],
										scopeLabel(run.scopePaths),
									],
									" · ",
								),
							]),
							// Phones drop the target and cost columns, so they ride under the run.
							h.span(
								[h.Class("truncate text-xs text-muted-foreground sm:hidden")],
								[`${repository} · ${formatUsd(runTotalUsd(run))}`],
							),
						],
					),
				],
				"max-sm:w-full max-sm:max-w-0",
			),
			tableCell(
				h,
				[
					vstack(h, { shrink: true, as: "span" }, [
						repositoryName(h, repository, "text-sm"),
						typography(h, { size: "xs", tone: "muted", mono: true, truncate: true }, [
							refLabel(run.sourceRef),
						]),
					]),
				],
				WIDE_COLUMN,
			),
			tableCell(h, [statusCell(h, run)]),
			tableCell(h, [findingsCell(h, runCountsOf(model, run.id), run)], cn("text-right", WIDE_COLUMN)),
			tableCell(
				h,
				[coverageCell(h, run, latestDetailOf(model, run.id))],
				cn("text-right", ROOMY_COLUMN),
			),
			tableCell(
				h,
				[formatUsd(runTotalUsd(run))],
				cn(typographyClass({ mono: true, numeric: true, className: "text-right" }), WIDE_COLUMN),
			),
			tableCell(
				h,
				[
					h.span(
						[h.Class("flex flex-col items-end")],
						[
							listRelativeTime(h, { value: run.startedAt, nowMs, timeZone, variant: "short" }),
							h.span([h.Title("Duration")], [formatElapsed(runElapsed(run, nowMs))]),
						],
					),
				],
				cn("text-right font-mono text-xs text-muted-foreground", WIDE_COLUMN),
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
					...Arr.map(targets, (target): SelectView.SelectEntry => ({
						_tag: "Item",
						item: { value: target.id, label: target.repository },
					})),
				],
				size: "sm",
				ariaLabel: "Target",
				className: "h-7 w-auto min-w-40 text-xs",
				renderValue: (value) => [
					h.span([h.Class("text-muted-foreground")], ["Target "]),
					value === "all" ? "All targets" : repositoryOf(targets, value),
				],
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
			toParentMessage: (message) => Message.GotRunsTargetSelectMessage({ message }),
		}),
		trailing: [toolbarCount(h, [isCapped ? `${RUN_LIST_CAP}+ runs` : countLabel(count, "run")])],
	})

/** "Start run" for the target the list is narrowed to. */
export const startRunAction = (h: H, model: Model): Html | undefined => {
	const targetId = model.runsSearch.target
	const found = Arr.findFirst(targetsOf(model), (candidate) => candidate.id === targetId)
	if (Option.isNone(found) || !canManage(model)) return undefined
	const target = found.value
	const isRunning = Arr.some(runsForTarget(model, target.id), isLive)
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
					canManage(model)
						? "Add a target, then start its first run."
						: "An org admin adds the first target on the Overview tab.",
				]),
			]),
			canManage(model)
				? button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedAddTarget())] }, [
						icon(h, "PlusIcon"),
						"Add target",
					])
				: linkButton(h, { size: "sm", variant: "outline", href: hrefOf(AppRoute.SecurityCode()) }, [
						"Open the overview",
					]),
		],
		emptyFrameClass("dashed"),
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
								: empty(
										h,
										[
											emptyHeader(h, [
												emptyTitle(h, ["No runs yet"]),
												emptyDescription(h, [
													"Runs start manually for now: pick a target and start one.",
												]),
											]),
										],
										emptyFrameClass("dashed"),
									),
						],
					)
				: table(h, { variant: "bare", ariaLabel: "Audit runs" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Run"]),
								tableHead(h, ["Target"], WIDE_COLUMN),
								tableHead(h, ["Status"]),
								tableHead(h, ["Findings"], cn("text-right", WIDE_COLUMN)),
								tableHead(h, ["Coverage"], cn("text-right", ROOMY_COLUMN)),
								tableHead(h, ["Cost"], cn("text-right", WIDE_COLUMN)),
								tableHead(h, ["Started"], cn("text-right", WIDE_COLUMN)),
							]),
						]),
						tableBody(
							h,
							Arr.map(runs, (run) => runRow(h, model, run, targets, timeZone)),
						),
					]),
	})
	return [
		borderedBox(
			h,
			{ as: "section", overflow: "hidden", card: true, attributes: [h.AriaLabel("Runs")] },
			// Nothing to narrow until there is a target, as on the Findings tab.
			[...(targets.length === 0 ? [] : [toolbar(h, model, targets, runs.length, isCapped)]), content],
		),
	]
}
