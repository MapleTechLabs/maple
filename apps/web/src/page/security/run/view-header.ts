import {
	type SecurityAuditRunDetail,
	type SecurityAuditTarget,
	SECURITY_AUDIT_MAX_BUDGET,
} from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { meter } from "../../../ui/meter"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { detailTitle } from "../../kit/detail-header"
import {
	formatElapsed,
	formatTokens,
	formatUsd,
	isCancelled,
	isLive,
	PROFILE_LABEL,
	RUN_KIND_LABEL,
	runElapsed,
	scopeLabel,
	shortSha,
} from "../kit/format"
import { iconTile, metaItem, runStatusBadge } from "../kit/parts"
import { countOf, gapCount, type Phase, type PhaseState, raisedBudget, type Verdicts } from "./derive"
import { Message, type Model } from "./model"

// The run's title block, its stop banner, the phase strip and the four totals.

type H = HtmlBuilder<Message>

export const runTitle = (
	h: H,
	run: SecurityAuditRunDetail,
	target: SecurityAuditTarget | null,
	nowMs: number,
	timeZone: string,
): Html => {
	const started = formatTimestampInTimezone(run.startedAt, { timeZone })
	const time = isLive(run)
		? `started ${formatElapsed(nowMs - run.startedAt)} ago`
		: `${started} to ${formatTimestampInTimezone(run.finishedAt ?? run.startedAt, { timeZone })} · ${formatElapsed(runElapsed(run, nowMs))}`
	return detailTitle(h, {
		kind: ["Audit run", RUN_KIND_LABEL[run.kind]],
		title: [
			h.span(
				[h.Class("flex min-w-0 items-center gap-2.5")],
				[
					iconTile(h, "GithubIcon"),
					h.span([h.Class("truncate")], [target?.repository ?? "Audit run"]),
				],
			),
		],
		titleText: target?.repository ?? "Audit run",
		adornment: runStatusBadge(h, run),
		meta: [
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground")],
				[
					metaItem(h, "BranchForkIcon", [
						`${target?.branch ?? "branch"} @ ${shortSha(run.sourceRef)}`,
					]),
					metaItem(h, run.scopePaths.length === 0 ? null : "FolderIcon", [
						h.span([h.Title(run.scopePaths.join("\n"))], [scopeLabel(run.scopePaths)]),
					]),
					metaItem(h, null, [PROFILE_LABEL[run.profile]]),
					metaItem(h, "ClockIcon", [time]),
				],
			),
		],
	})
}

export const runActions = (h: H, model: Model, run: SecurityAuditRunDetail): Html =>
	h.div(
		[h.Class("flex items-center gap-2")],
		[
			...(run.reports === null
				? []
				: [
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								attributes: [h.OnClick(Message.ClickedReport({ report: "report" }))],
							},
							[icon(h, "FileIcon"), "Report"],
						),
					]),
			...(!model.isAdmin
				? []
				: isLive(run)
					? [
							button(
								h,
								{
									size: "sm",
									variant: "destructive-outline",
									isDisabled: model.busy !== null,
									attributes: [h.OnClick(Message.ClickedCancel())],
								},
								["Cancel run"],
							),
						]
					: [
							button(
								h,
								{
									size: "sm",
									isDisabled: model.busy !== null,
									attributes: [h.OnClick(Message.ClickedStartRun({ budget: null }))],
								},
								[
									icon(h, "MediaPlayIcon"),
									model.busy === "start" ? "Starting..." : "Start run",
								],
							),
						]),
		],
	)

/** Why a finished run stopped short, and what the next run does about it. */
export const stopBanner = (h: H, model: Model, run: SecurityAuditRunDetail): Html | null => {
	if (isLive(run)) return null
	if (run.status === "failed")
		return alert(h, { variant: "crit" }, [
			icon(h, "CircleWarningIcon"),
			alertTitle(h, ["The audit could not finish"]),
			alertDescription(h, [
				run.error ?? "The run failed before it wrote its results. Start it again to retry.",
			]),
		])
	if (isCancelled(run))
		return alert(h, {}, [
			icon(h, "CircleInfoIcon"),
			alertTitle(h, ["Cancelled"]),
			alertDescription(h, [
				`An admin stopped this run after ${run.invocationsSpent.toLocaleString("en-US")} invocations. What it closed is kept; the next run starts with the rest.`,
			]),
		])
	if (run.status !== "incomplete") return null
	const gaps = gapCount(run)
	const raised = raisedBudget(run.budget, SECURITY_AUDIT_MAX_BUDGET)
	const isBudget = run.budget !== null && run.invocationsSpent >= run.budget
	return alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, [
			isBudget
				? `Stopped at its budget of ${run.budget?.toLocaleString("en-US")} invocations`
				: "Stopped before it covered everything",
		]),
		alertDescription(h, [
			[
				gaps > 0
					? `${gaps} of ${run.unitTotal} units were not audited. They are listed as gaps below and are not counted as covered.`
					: (run.incompleteReason ?? "The run ended early."),
				"The next run carries forward the closed units and starts with these gaps.",
			].join(" "),
		]),
		...(model.isAdmin && raised !== null && raised > (run.budget ?? 0)
			? [
					alertAction(h, [
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: model.busy !== null,
								attributes: [h.OnClick(Message.ClickedStartRun({ budget: raised }))],
							},
							[`Run again with ${raised.toLocaleString("en-US")}`],
						),
					]),
				]
			: []),
	])
}

const PHASE_BAR = {
	done: "bg-severity-info",
	active: "bg-severity-debug",
	warn: "bg-severity-warn",
	stopped: "bg-severity-error",
	pending: "bg-transparent",
	skipped: "bg-transparent",
} satisfies Record<PhaseState, string>

const phaseMark = (h: H, state: PhaseState): Html => {
	switch (state) {
		case "done":
			return icon(h, "CircleCheckIcon", { size: 16, className: "text-severity-info" })
		case "warn":
			return icon(h, "AlertWarningIcon", { size: 16, className: "text-severity-warn" })
		case "stopped":
			return icon(h, "CircleXmarkIcon", { size: 16, className: "text-severity-error" })
		case "active":
			return h.span(
				[
					h.AriaHidden(true),
					h.Class(
						"flex size-4 items-center justify-center rounded-full border-2 border-severity-debug",
					),
				],
				[h.span([h.Class("size-1.5 rounded-full bg-severity-debug")])],
			)
		case "pending":
		case "skipped":
			return h.span([
				h.AriaHidden(true),
				h.Class("size-4 rounded-full border-2 border-muted-foreground/40"),
			])
	}
}

const PHASE_STATE_LABEL = {
	done: "done",
	active: "in progress",
	warn: "finished with gaps",
	stopped: "stopped here",
	pending: "not started",
	skipped: "skipped",
} satisfies Record<PhaseState, string>

/** A static strip: the active phase is marked, never animated. */
export const phaseStrip = (h: H, phases: ReadonlyArray<Phase>): Html =>
	h.ol(
		[
			h.AriaLabel("Run phases"),
			h.Class(
				"grid divide-y overflow-hidden rounded-md border bg-card md:grid-cols-5 md:divide-x md:divide-y-0",
			),
		],
		phases.map((phase) =>
			h.li(
				[
					h.Key(phase.name),
					h.AriaLabel(`${phase.name}, ${PHASE_STATE_LABEL[phase.state]}`),
					h.Class(cn("flex flex-col gap-2 px-4 py-3", phase.state === "active" && "bg-muted/40")),
				],
				[
					h.span(
						[
							h.Class(
								cn(
									"flex items-center gap-2 text-sm",
									phase.state === "pending" || phase.state === "skipped"
										? "text-muted-foreground"
										: "font-medium",
								),
							),
						],
						[phaseMark(h, phase.state), phase.name],
					),
					h.span(
						[h.AriaHidden(true), h.Class("h-1 w-full overflow-hidden rounded-full bg-muted")],
						[
							h.span([
								h.Class(
									cn(
										"block h-full",
										PHASE_BAR[phase.state],
										phase.state === "active" ? "w-1/2" : "w-full",
									),
								),
							]),
						],
					),
					h.span([h.Class("text-xs text-muted-foreground")], [phase.detail]),
				],
			),
		),
	)

export const runStats = (h: H, run: SecurityAuditRunDetail, verdicts: Verdicts | null): Html => {
	const tokens = run.inputTokens + run.outputTokens
	const perInvocation =
		run.costUsd !== null && run.invocationsSpent > 0 ? run.costUsd / run.invocationsSpent : null
	const live = isLive(run)
	return statRail(h, { columns: 4 }, [
		statRailItem(h, {
			eyebrow: "Invocations",
			value: h.span(
				[h.Class("flex flex-col gap-2")],
				[
					h.span(
						[],
						[
							run.invocationsSpent.toLocaleString("en-US"),
							...(run.budget === null
								? []
								: [
										h.span(
											[h.Class("ml-1.5 text-sm font-normal text-muted-foreground")],
											[`of ${run.budget.toLocaleString("en-US")}`],
										),
									]),
						],
					),
					...(run.budget === null
						? []
						: [
								meter(h, {
									value: run.invocationsSpent,
									max: run.budget,
									tone: run.invocationsSpent >= run.budget ? "warn" : undefined,
									className: "w-40",
									label: `${run.invocationsSpent} of ${run.budget} invocations`,
								}),
							]),
				],
			),
			compact: true,
			subline:
				run.budget !== null && run.invocationsSpent >= run.budget
					? "budget used in full"
					: live
						? "spent so far"
						: "spent",
		}),
		statRailItem(h, {
			eyebrow: "Tokens",
			value: formatTokens(tokens),
			compact: true,
			subline: `${formatTokens(run.inputTokens)} input · ${formatTokens(run.outputTokens)} output`,
		}),
		statRailItem(h, {
			eyebrow: live ? "Cost so far" : "Cost",
			value: formatUsd(run.costUsd),
			compact: true,
			subline:
				perInvocation === null
					? "no invocations priced yet"
					: `${formatUsd(perInvocation)} per invocation on average`,
		}),
		live || verdicts === null
			? statRailItem(h, {
					eyebrow: "Candidates",
					value: String(countOf(run, "candidate")),
					compact: true,
					subline: "not findings until a second model fails to disprove them",
				})
			: statRailItem(h, {
					eyebrow: "Verdicts",
					value: `${verdicts.confirmed} confirmed`,
					compact: true,
					subline: `${verdicts.needsValidation} needs validation · ${verdicts.rejected} rejected`,
				}),
	])
}
