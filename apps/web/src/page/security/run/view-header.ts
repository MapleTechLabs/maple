import { NARROW_TWO_COLUMNS } from "../kit/layout"
import type { SecurityAuditRunDetail, SecurityAuditTarget } from "@maple/domain/http"
import { executionModeLine } from "@maple/domain/security-audit"
import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { detailTitle } from "../../kit/detail-header"
import {
	formatElapsed,
	formatUsd,
	incompleteReasonLabel,
	isCancelled,
	isLive,
	isSpendLimitStop,
	modelLabel,
	PROFILE_LABEL,
	RUN_KIND_LABEL,
	runElapsed,
	scopeLabel,
	refLabel,
} from "../kit/format"
import { iconTile, metaItem, runStatusBadge } from "../kit/parts"
import { countOf, gapCount, type Phase, type PhaseState, type Verdicts } from "./derive"
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
						`${target?.branch ?? "branch"} @ ${refLabel(run.sourceRef)}`,
					]),
					metaItem(h, run.scopePaths.length === 0 ? null : "FolderIcon", [
						h.span([h.Title(run.scopePaths.join("\n"))], [scopeLabel(run.scopePaths)]),
					]),
					metaItem(h, null, [PROFILE_LABEL[run.profile]]),
					...(run.discoveryModel === null
						? []
						: [metaItem(h, null, [modelLabel(run.discoveryModel)])]),
					metaItem(h, "ClockIcon", [time]),
				],
			),
			// Why execution-bound leads stay unvalidated: the run's own label, one quiet line.
			...(run.executionProfile === null
				? []
				: [
						h.p(
							[h.Class("w-full text-sm text-muted-foreground")],
							[metaItem(h, "FileCodeIcon", [executionModeLine(run.executionProfile)])],
						),
					]),
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
									attributes: [h.OnClick(Message.ClickedStartRun())],
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
				"An admin stopped this run. What it closed is kept; the next run starts with the rest.",
			]),
		])
	if (run.status !== "incomplete") return null
	const gaps = gapCount(run)
	const isLimit = isSpendLimitStop(run)
	return alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, [
			isLimit ? "Stopped at the org's monthly spend limit" : "Stopped before it covered everything",
		]),
		alertDescription(h, [
			[
				gaps > 0
					? `${gaps} of ${run.unitTotal} units were not audited. They are listed as gaps below and are not counted as covered.`
					: `The run ended early: ${incompleteReasonLabel(run.incompleteReason)}.`,
				"The next run carries forward the closed units and starts with these gaps.",
				...(isLimit ? ["The limit resets on the 1st of the month (UTC)."] : []),
			].join(" "),
		]),
		...(model.isAdmin && isLimit
			? [
					alertAction(h, [
						linkButton(h, { size: "sm", variant: "outline", href: hrefOf(AppRoute.Security()) }, [
							"Raise the limit",
						]),
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
			// Phases wrap onto more rows as the column narrows; each row fills its width.
			h.Class("flex flex-wrap gap-px overflow-hidden rounded-md border bg-border"),
		],
		phases.map((phase) =>
			h.li(
				[
					h.Key(phase.name),
					h.AriaLabel(`${phase.name}, ${PHASE_STATE_LABEL[phase.state]}`),
					h.Class(
						cn(
							"flex min-w-44 flex-1 flex-col gap-2 bg-card px-4 py-3",
							phase.state === "active" && "bg-muted",
						),
					),
				],
				[
					h.span(
						[
							h.Class(
								cn(
									"flex min-w-0 items-center gap-2 text-sm",
									phase.state === "pending" || phase.state === "skipped"
										? "text-muted-foreground"
										: "font-medium",
								),
							),
						],
						[phaseMark(h, phase.state), h.span([h.Class("truncate")], [phase.name])],
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
	const live = isLive(run)
	return statRail(h, { columns: 4, className: NARROW_TWO_COLUMNS }, [
		statRailItem(h, {
			eyebrow: "Models",
			value: run.discoveryModel === null ? "Not recorded" : modelLabel(run.discoveryModel),
			valueClassName: "text-base",
			compact: true,
			subline:
				run.validationModel === null
					? "runs from before models were recorded"
					: `verified by ${modelLabel(run.validationModel)}`,
		}),
		statRailItem(h, {
			eyebrow: "Tokens",
			value: formatNumber(tokens),
			compact: true,
			subline: `${formatNumber(run.inputTokens)} input · ${formatNumber(run.outputTokens)} output`,
		}),
		statRailItem(h, {
			eyebrow: live ? "Cost so far" : "Cost",
			value: formatUsd(run.costUsd),
			compact: true,
			subline:
				run.costUsd === null
					? live
						? "priced when the run settles"
						: "not reported by the provider"
					: "at the model provider's price",
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
