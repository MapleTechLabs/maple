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
	runTotalUsd,
	isCancelled,
	isLive,
	modelLabel,
	PROFILE_LABEL,
	RUN_KIND_LABEL,
	runElapsed,
	scopeLabel,
	refLabel,
} from "../kit/format"
import { leadsLine, type StopAction, stopNoteOf } from "../kit/outcome"
import { iconTile, metaItem, placeholder, runStatusBadge } from "../kit/parts"
import { meter } from "../../../ui/meter"
import { countOf, gapCount, type Phase, type PhaseState, type Verdicts } from "./derive"
import { Message, type Model } from "./model"
import { statusDot } from "../../../ui/status-dot"

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
						: [
								metaItem(h, null, [
									run.validationModel === null
										? modelLabel(run.discoveryModel)
										: `${modelLabel(run.discoveryModel)}, verified by ${modelLabel(run.validationModel)}`,
								]),
							]),
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
									isLoading: model.busy === "start",
									isDisabled: model.busy !== null,
									attributes: [h.OnClick(Message.ClickedStartRun())],
								},
								[icon(h, "MediaPlayIcon"), "Start run"],
							),
						]),
		],
	)

const startRunButton = (h: H, model: Model): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "outline",
			isLoading: model.busy === "start",
			isDisabled: model.busy !== null,
			attributes: [h.OnClick(Message.ClickedStartRun())],
		},
		["Start run"],
	)

const stopAction = (h: H, model: Model, action: StopAction): ReadonlyArray<Html> => {
	if (!model.isAdmin || action === null) return []
	const control =
		action === "start"
			? startRunButton(h, model)
			: linkButton(h, { size: "sm", variant: "outline", href: hrefOf(AppRoute.SecurityCode()) }, [
					action === "limit" ? "Raise the limit" : "Spend & models",
				])
	return [alertAction(h, [control])]
}

/** Why a finished run stopped short, in one sentence, and what to do next. */
export const stopBanner = (h: H, model: Model, run: SecurityAuditRunDetail): Html | null => {
	if (isLive(run)) return null
	if (run.status === "failed")
		return alert(h, { variant: "crit" }, [
			icon(h, "CircleWarningIcon"),
			alertTitle(h, ["The audit could not finish"]),
			alertDescription(h, [
				run.error ?? "The run failed before it wrote its results. Start it again to retry.",
			]),
			...stopAction(h, model, "start"),
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
	const note = stopNoteOf(run.incompleteReason, gapCount(run))
	return alert(h, { variant: note.tone }, [
		icon(h, note.tone === "crit" ? "CircleWarningIcon" : "AlertWarningIcon"),
		alertTitle(h, [note.title]),
		alertDescription(h, [note.body]),
		...stopAction(h, model, note.action),
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
				[statusDot(h, { tone: "done" })],
			)
		case "pending":
		case "skipped":
			return h.span([
				h.AriaHidden(true),
				h.Class("size-4 rounded-full border-2 border-foreground-faint"),
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

export const runStats = (
	h: H,
	run: SecurityAuditRunDetail,
	verdicts: Verdicts | null,
	areas: number | null,
	nowMs: number,
): Html => {
	const live = isLive(run)
	const gaps = gapCount(run)
	const closed = run.unitTotal - gaps
	const tokens = `${formatNumber(run.inputTokens)} input · ${formatNumber(run.outputTokens)} output tokens`
	const leads = verdicts === null ? null : verdicts.confirmed + verdicts.needsValidation
	const waiting = countOf(run, "candidate")
	return statRail(h, { columns: 4, className: NARROW_TWO_COLUMNS }, [
		statRailItem(h, {
			eyebrow: "Leads",
			value: leads === null ? placeholder(h, "h-7 w-10") : String(leads),
			compact: true,
			subline:
				verdicts === null
					? undefined
					: live
						? `${leadsLine(verdicts.confirmed, verdicts.needsValidation)} · ${waiting} ${waiting === 1 ? "candidate" : "candidates"} waiting`
						: [
								leadsLine(verdicts.confirmed, verdicts.needsValidation),
								...(verdicts.rejected === 0 ? [] : [`${verdicts.rejected} disproved`]),
							].join(" · "),
		}),
		statRailItem(h, {
			eyebrow: "Coverage",
			value: run.unitTotal === 0 ? "Not mapped" : `${closed} / ${run.unitTotal}`,
			hint: run.unitTotal === 0 ? undefined : "units",
			compact: true,
			subline:
				run.unitTotal === 0
					? live
						? "mapping the code"
						: "no units were planned"
					: h.span(
							[h.Class("flex flex-col gap-1.5")],
							[
								meter(h, {
									value: closed,
									max: run.unitTotal,
									tone: gaps > 0 && !live ? "warn" : undefined,
									label: `${closed} of ${run.unitTotal} units closed`,
								}),
								[
									...(areas === null || areas === 0
										? []
										: [`${areas} ${areas === 1 ? "area" : "areas"}`]),
									gaps === 0
										? "no gaps"
										: `${gaps} ${live ? "still open" : gaps === 1 ? "gap" : "gaps"}`,
								].join(" · "),
							],
						),
		}),
		statRailItem(h, {
			eyebrow: live ? "Cost so far" : "Cost",
			value: h.span([h.Title(tokens)], [formatUsd(runTotalUsd(run))]),
			compact: true,
			subline:
				run.costUsd === null
					? live
						? `models priced when the run settles · ${formatUsd(run.sandboxUsd)} sandbox`
						: "not reported by the provider"
					: `${formatUsd(run.costUsd)} models · ${formatUsd(run.sandboxUsd)} sandbox`,
		}),
		statRailItem(h, {
			eyebrow: live ? "Running for" : "Duration",
			value: formatElapsed(runElapsed(run, nowMs)),
			compact: true,
			subline: `${formatNumber(run.invocationsSpent)} ${run.invocationsSpent === 1 ? "agent" : "agents"} run`,
		}),
	])
}
