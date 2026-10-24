import { NARROW_TWO_COLUMNS } from "../kit/layout"
import type { SecurityAuditFinding, SecurityAuditRun, SecurityAuditTarget } from "@maple/domain/http"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import { formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { meter } from "../../../ui/meter"
import { panel, panelHeader } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { SEVERITY_FILL } from "../../errors/kit/severity"
import {
	formatElapsed,
	formatUsd,
	type Gate,
	gateOf,
	incompleteReasonLabel,
	isLive,
	locationOf,
	modelLabel,
	PROFILE_LABEL,
	RUN_KIND_LABEL,
	runLabelOf,
	runToneOf,
	SECURITY_SEVERITY_LABEL,
	refLabel,
	targetLine,
} from "../kit/format"
import {
	gateState,
	placeholder,
	placeholderRows,
	repositoryName,
	runStatusBadge,
	severityLabel,
} from "../kit/parts"
import {
	bySeverity,
	countBySeverity,
	coverageOf,
	findingsStateOf,
	latestDetailOf,
	latestRunFor,
	RUN_LIST_CAP,
	type Spend,
	openConfirmed,
	openNeedsValidation,
	runningRuns,
	runsOf,
	settingsOf,
	spendThisMonth,
	targetsOf,
} from "./derive"
import { Message, type Model } from "./model"
import { auditSteps, emptyOnRamp } from "./view-empty"

// The Overview tab: totals, the targets table, new confirmed findings and recent runs.

type H = HtmlBuilder<Message>

const runHref = (run: SecurityAuditRun) => hrefOf(AppRoute.SecurityRun({ runId: run.id }))
const targetRunsHref = (target: SecurityAuditTarget) =>
	hrefOf(AppRoute.SecurityRuns({ search: { target: target.id } }))

const findingsOfTarget = (
	model: Model,
	targetId: string,
): ReadonlyArray<SecurityAuditFinding> | Gate | null => {
	const slot = model.findings[targetId]
	if (slot === undefined) return null
	if (AsyncData.isFailure(slot.data)) return gateOf(slot.data.error) ?? null
	return AsyncData.hasData(slot.data)
		? AsyncData.getOrElse(slot.data, () => ({ findings: [] })).findings
		: null
}

// KPIs

/** What the spend covers, and plainly when it is not all of it. */
const spendNote = (spend: Spend): string =>
	[
		`${formatNumber(spend.tokens)} tokens`,
		...(spend.unpriced === 0
			? []
			: [`excludes ${spend.unpriced} unpriced ${spend.unpriced === 1 ? "run" : "runs"}`]),
		...(spend.isPartial ? [`newest ${RUN_LIST_CAP} runs per target only`] : []),
	].join(" · ")

const monthDay = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** This month's spend against the org's limit; the runs' own costs until the settings load. */
const spendTile = (h: H, model: Model): Html => {
	const settings = settingsOf(model)
	if (settings === null) {
		const spend = spendThisMonth(model)
		return statRailItem(h, {
			eyebrow: "Spend this month",
			value: formatUsd(spend.costUsd),
			compact: true,
			subline: spendNote(spend),
		})
	}
	const limit = settings.monthlySpendLimitUsd
	const isReached = settings.spentUsd >= limit
	return statRailItem(h, {
		eyebrow: "Spend this month",
		value: formatUsd(settings.spentUsd),
		hint: `of ${formatUsd(limit)}`,
		tone: isReached ? "warn" : undefined,
		compact: true,
		action: model.isAdmin
			? h.button(
					[
						h.Type("button"),
						h.OnClick(Message.ClickedSpendAndModels()),
						h.Class(
							"text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
						),
					],
					["Edit limit"],
				)
			: undefined,
		subline: h.span(
			[h.Class("flex flex-col gap-1.5")],
			[
				meter(h, {
					value: Math.min(settings.spentUsd, limit),
					max: limit,
					tone: isReached ? "warn" : undefined,
					label: `${formatUsd(settings.spentUsd)} of ${formatUsd(limit)} spent this month`,
				}),
				isReached
					? `Limit reached · runs resume ${monthDay(settings.resetsAt)}`
					: `${formatUsd(limit - settings.spentUsd)} left · resets ${monthDay(settings.resetsAt)}`,
			],
		),
	})
}

const kpis = (h: H, model: Model): Html => {
	const state = findingsStateOf(model)
	const findings = state._tag === "Ready" ? state.findings : []
	const confirmed = openConfirmed(findings)
	const counts = countBySeverity(confirmed)
	// Gated reads as words; still loading is the same still block as every other placeholder.
	const unknown: Html | string | null =
		state._tag === "Ready" ? null : state._tag === "Gated" ? "Admins only" : placeholder(h, "h-7 w-10")
	const running = runningRuns(model).length
	return statRail(h, { columns: 4, className: NARROW_TWO_COLUMNS }, [
		statRailItem(h, {
			eyebrow: "Open findings",
			value: unknown ?? String(confirmed.length),
			compact: true,
			subline:
				unknown === null
					? (["critical", "high", "medium", "low"] as const)
							.map(
								(severity) =>
									`${counts[severity]} ${SECURITY_SEVERITY_LABEL[severity].toLowerCase()}`,
							)
							.join(" · ")
					: undefined,
		}),
		statRailItem(h, {
			eyebrow: "Needs validation",
			value: unknown ?? String(openNeedsValidation(findings).length),
			compact: true,
			subline: unknown === null ? "need code execution to prove or reject" : undefined,
		}),
		statRailItem(h, {
			eyebrow: "Targets",
			value: String(targetsOf(model).length),
			compact: true,
			subline:
				running === 0
					? "no audit running"
					: `${running} ${running === 1 ? "audit" : "audits"} running now`,
		}),
		spendTile(h, model),
	])
}

// TARGETS TABLE

const severityCounts = (h: H, findings: ReadonlyArray<SecurityAuditFinding>): Html => {
	const counts = countBySeverity(openConfirmed(findings))
	return h.span(
		[h.Class("flex items-center gap-3 font-mono text-xs tabular-nums")],
		(["critical", "high", "medium", "low"] as const).map((severity) =>
			h.span(
				[
					h.Key(severity),
					h.Class("inline-flex items-center gap-1.5"),
					h.Title(`${counts[severity]} ${severity}`),
				],
				[
					statusDot(h, { tone: "custom", size: "lg", className: SEVERITY_FILL[severity] }),
					String(counts[severity]),
				],
			),
		),
	)
}

const lastRunCell = (h: H, model: Model, run: SecurityAuditRun | undefined): Html => {
	if (run === undefined) return h.span([h.Class("text-xs text-muted-foreground")], ["No run yet"])
	const detail = isLive(run)
		? `running for ${formatElapsed(model.nowMs - run.startedAt)}`
		: run.status === "failed"
			? (run.error ?? "the audit could not start")
			: run.status === "incomplete"
				? incompleteReasonLabel(run.incompleteReason)
				: `${formatElapsed((run.finishedAt ?? run.startedAt) - run.startedAt)} · ${refLabel(run.sourceRef)}`
	return h.div(
		[h.Class("flex min-w-0 flex-col items-start gap-1")],
		[
			runStatusBadge(h, run),
			h.span([h.Class("max-w-64 truncate text-xs text-muted-foreground"), h.Title(detail)], [detail]),
		],
	)
}

const coverageCell = (h: H, model: Model, run: SecurityAuditRun | undefined): Html => {
	const detail = run === undefined ? null : latestDetailOf(model, run.id)
	if (run === undefined || detail === null || detail.unitTotal === 0)
		return h.span([h.Class("text-xs text-muted-foreground")], [run === undefined ? "" : "not mapped"])
	const { closed, total } = coverageOf(detail)
	return h.div(
		[h.Class("flex items-center justify-end gap-2")],
		[
			meter(h, {
				value: closed,
				max: total,
				tone: runToneOf(run),
				className: "w-14",
				label: `${closed} of ${total} units closed`,
			}),
			h.span(
				[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
				[`${closed} / ${total}`],
			),
		],
	)
}

/** The model a target hunts with: its own pick, else the org's. */
const targetModelOf = (model: Model, target: SecurityAuditTarget): string | null => {
	const id = target.discoveryModel ?? settingsOf(model)?.discoveryModel ?? null
	return id === null ? null : modelLabel(id)
}

const targetRow = (h: H, model: Model, target: SecurityAuditTarget): Html => {
	const run = latestRunFor(model, target.id)
	const findings = findingsOfTarget(model, target.id)
	const href = run === undefined ? targetRunsHref(target) : runHref(run)
	const isFindingsKnown = typeof findings === "object" && findings !== null
	return tableRow(
		h,
		[
			tableCell(h, [
				h.a(
					[h.Href(href), h.Class("flex min-w-0 items-center gap-2.5")],
					[
						icon(h, "GithubIcon", { size: 16, className: "shrink-0 text-muted-foreground" }),
						h.span(
							[h.Class("flex min-w-0 flex-col")],
							[
								repositoryName(h, target.repository, "text-sm font-medium"),
								h.span(
									[h.Class("truncate text-xs text-muted-foreground")],
									[
										[targetLine(target), targetModelOf(model, target)]
											.filter((part) => part !== null)
											.join(" · "),
									],
								),
							],
						),
					],
				),
			]),
			tableCell(h, [lastRunCell(h, model, run)]),
			tableCell(h, [
				isFindingsKnown
					? run === undefined || run.status === "failed"
						? findings.length === 0
							? h.span([h.Class("text-xs text-muted-foreground")], ["No completed run yet"])
							: severityCounts(h, findings)
						: severityCounts(h, findings)
					: h.span(
							[h.Class("text-xs text-muted-foreground")],
							[findings === "forbidden" ? "Admins only" : ""],
						),
			]),
			tableCell(
				h,
				[isFindingsKnown ? String(openNeedsValidation(findings).length) : ""],
				"text-right font-mono tabular-nums",
			),
			tableCell(h, [coverageCell(h, model, run)], "text-right"),
			tableCell(
				h,
				[run === undefined ? "" : formatUsd(run.costUsd)],
				"text-right font-mono tabular-nums",
			),
			tableCell(
				h,
				[
					h.a(
						[
							h.Href(href),
							h.AriaLabel(`Open ${target.repository}`),
							h.Class("text-muted-foreground hover:text-foreground"),
						],
						[icon(h, "ChevronRightIcon", { size: 14 })],
					),
				],
				"w-8",
			),
		],
		undefined,
		[h.Key(target.id)],
	)
}

const targetsPanel = (h: H, model: Model, targets: ReadonlyArray<SecurityAuditTarget>): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Targets",
			action: h.span(
				[h.Class("text-xs text-muted-foreground")],
				["One audit runs per target at a time"],
			),
		}),
		table(h, { variant: "bare", ariaLabel: "Audit targets" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Repository"]),
					tableHead(h, ["Last run"]),
					tableHead(h, ["Open findings"]),
					tableHead(h, ["Needs val."], "text-right"),
					tableHead(h, ["Coverage"], "text-right"),
					tableHead(h, ["Run cost"], "text-right"),
					tableHead(h, [h.span([h.Class("sr-only")], ["Open"])], "w-8"),
				]),
			]),
			tableBody(
				h,
				targets.map((target) => targetRow(h, model, target)),
			),
		]),
	])

// BOTTOM PANELS

const findingHref = (finding: SecurityAuditFinding) =>
	hrefOf(AppRoute.SecurityFinding({ targetId: finding.targetId, fingerprint: finding.fingerprint }))

const listLink = <M>(h: HtmlBuilder<M>, href: string, children: ReadonlyArray<Html>, key: string): Html =>
	h.li(
		[h.Key(key)],
		[
			h.a(
				[
					h.Href(href),
					h.Class("flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40"),
				],
				children,
			),
		],
	)

const findingItem = (h: H, finding: SecurityAuditFinding, repository: string): Html =>
	listLink(
		h,
		findingHref(finding),
		[
			h.span(
				[h.Class("w-16 shrink-0 text-xs uppercase")],
				[finding.overallSeverity === null ? "" : severityLabel(h, finding.overallSeverity)],
			),
			h.span(
				[h.Class("flex min-w-0 flex-col")],
				[
					h.span([h.Class("truncate text-sm")], [finding.record.title]),
					h.span(
						[h.Class("truncate text-xs text-muted-foreground")],
						[
							[repository, locationOf(finding.record) ?? ""]
								.filter((part) => part !== "")
								.join(" · "),
						],
					),
				],
			),
		],
		`${finding.targetId}/${finding.fingerprint}`,
	)

const topFindingsList = (
	h: H,
	findings: ReadonlyArray<SecurityAuditFinding>,
	targets: ReadonlyArray<SecurityAuditTarget>,
): Html => {
	const rows = [...openConfirmed(findings)].sort(bySeverity).slice(0, 4)
	return rows.length === 0
		? h.p([h.Class("px-4 py-6 text-sm text-muted-foreground")], ["No open confirmed findings."])
		: h.ul(
				[h.Class("divide-y")],
				rows.map((finding) =>
					findingItem(
						h,
						finding,
						targets.find((target) => target.id === finding.targetId)?.repository ?? "",
					),
				),
			)
}

/** The worst open confirmed findings: severity first, then the most recently seen. */
const topFindingsPanel = (h: H, model: Model, targets: ReadonlyArray<SecurityAuditTarget>): Html => {
	const state = findingsStateOf(model)
	const body =
		state._tag === "Gated"
			? gateState(h, state.gate, "m-4")
			: state._tag === "Failed"
				? errorState(h, {
						failure: state.failure,
						title: "Failed to load findings",
						variant: "inline",
						onRetry: Message.ClickedRetry(),
					})
				: state._tag === "Loading"
					? placeholderRows(h, 4)
					: topFindingsList(h, state.findings, targets)
	return panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Most severe open findings",
			action: h.a(
				[
					h.Href(hrefOf(AppRoute.SecurityFindings({ search: {} }))),
					h.Class("text-xs text-muted-foreground underline-offset-2 hover:underline"),
				],
				["All findings"],
			),
		}),
		body,
	])
}

const recentRunsPanel = (h: H, model: Model, targets: ReadonlyArray<SecurityAuditTarget>): Html => {
	const runs = runsOf(model).slice(0, 4)
	return panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Recent runs",
			action: h.span([h.Class("text-xs text-muted-foreground")], ["Manual runs only for now"]),
		}),
		runs.length === 0
			? h.p(
					[h.Class("px-4 py-6 text-sm text-muted-foreground")],
					["No runs yet. Start one from a target."],
				)
			: h.ul(
					[h.Class("divide-y")],
					runs.map((run) => {
						const repository =
							targets.find((target) => target.id === run.targetId)?.repository ??
							"Removed target"
						const tone = runToneOf(run)
						const note = isLive(run)
							? `${formatNumber(run.inputTokens + run.outputTokens)} tokens so far`
							: run.status === "failed"
								? "could not finish"
								: `${formatElapsed((run.finishedAt ?? run.startedAt) - run.startedAt)} · ${formatNumber(run.inputTokens + run.outputTokens)} tokens`
						return listLink(
							h,
							runHref(run),
							[
								h.span(
									[h.Class("flex min-w-0 flex-1 flex-col")],
									[
										h.span([h.Class("truncate text-sm")], [repository]),
										h.span(
											[h.Class("truncate text-xs text-muted-foreground")],
											[
												[
													RUN_KIND_LABEL[run.kind].toLowerCase(),
													PROFILE_LABEL[run.profile],
													note,
												].join(" · "),
											],
										),
									],
								),
								h.span([h.Class(cn("text-xs", TONE_TEXT[tone]))], [runLabelOf(run)]),
								h.span(
									[h.Class("w-20 text-right font-mono text-sm tabular-nums")],
									[formatUsd(run.costUsd)],
								),
							],
							run.id,
						)
					}),
				),
	])
}

const overviewLoading = (h: H): ReadonlyArray<Html> => [
	h.div(
		[h.Class("grid grid-cols-2 gap-px md:grid-cols-4")],
		Array.from({ length: 4 }, () => placeholder(h, "h-24")),
	),
	placeholder(h, "h-64 w-full"),
]

export const overviewBody = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.matchData(model.targets.data, {
		onEmpty: () => overviewLoading(h),
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: "Failed to load audit targets",
				onRetry: Message.ClickedRetry(),
			}),
		],
		onData: ({ targets }) =>
			targets.length === 0
				? [emptyOnRamp(h, model), auditSteps(h)]
				: [
						kpis(h, model),
						targetsPanel(h, model, targets),
						h.div(
							[h.Class("grid gap-6 lg:grid-cols-2")],
							[topFindingsPanel(h, model, targets), recentRunsPanel(h, model, targets)],
						),
					],
	})

/** Admins add targets; a member gets no control they would be refused. */
export const addTargetButton = (h: H, model: Model): Html | undefined =>
	model.isAdmin
		? button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedAddTarget())] }, [
				icon(h, "PlusIcon"),
				"Add target",
			])
		: undefined

/** The Overview's actions: Spend & models once the settings are in, then Add target. */
export const overviewActions = (h: H, model: Model): Html | undefined => {
	const add = addTargetButton(h, model)
	if (add === undefined) return undefined
	if (settingsOf(model) === null) return add
	return h.div(
		[h.Class("flex items-center gap-2")],
		[
			button(
				h,
				{ size: "sm", variant: "outline", attributes: [h.OnClick(Message.ClickedSpendAndModels())] },
				[icon(h, "GearIcon"), "Spend & models"],
			),
			add,
		],
	)
}
