import { NARROW_TWO_COLUMNS } from "../kit/layout"
import type { SecurityAuditFinding, SecurityAuditRun, SecurityAuditTarget } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { textLink } from "../../../ui/text-link"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { meter } from "../../../ui/meter"
import { skeletonSlowNote } from "../../../ui/skeleton"
import { panel, panelHeader } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import { ROW_LINK_LIFT, rowLink, table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { statRail, statRailItem } from "../../kit/stat-rail"
import {
	formatElapsed,
	formatUsd,
	runTotalUsd,
	type Gate,
	gateOf,
	isLive,
	locationOf,
	modelLabel,
	PROFILE_LABEL,
	RUN_KIND_LABEL,
	SECURITY_SEVERITY_LABEL,
	runToneOf,
	refLabel,
	targetParts,
} from "../kit/format"
import {
	gateState,
	placeholder,
	placeholderRows,
	repositoryName,
	runStatusBadge,
	SECURITY_SEVERITY_FILL,
	securitySeverityBadge,
} from "../kit/parts"
import {
	coverageAcross,
	coverageSettled,
	coverageOf,
	findingsStateOf,
	latestDetailOf,
	latestRunFor,
	RUN_LIST_CAP,
	type Spend,
	openConfirmed,
	openLeads,
	openNeedsValidation,
	runningRuns,
	runsOf,
	settingsOf,
	spendThisMonth,
	targetsOf,
} from "./derive"
import { Message, type Model } from "./model"
import { bucketOf, countByBucket, isUnverified } from "../kit/findings"
import { findingBadge } from "../kit/findings-view"
import { auditSteps, emptyOnRamp } from "./view-empty"
import { leadsLine, stopSummaryOf } from "../kit/outcome"
import { emptyMessage } from "../../../ui/empty"

// The Overview tab: totals, the targets table, open leads and recent runs.

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
			: [`models not yet priced for ${spend.unpriced} ${spend.unpriced === 1 ? "run" : "runs"}`]),
		...(spend.isPartial ? [`newest ${RUN_LIST_CAP} runs per target only`] : []),
	].join(" · ")

const monthDay = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** This month's spend against the org's limit; the runs' own costs until the settings load. */
const spendTile = (h: H, model: Model): Html => {
	const settings = settingsOf(model)
	if (settings === null && AsyncData.isFailure(model.settings.data))
		return statRailItem(h, {
			eyebrow: "Spend this month",
			value: "Unavailable",
			valueClassName: "text-base",
			compact: true,
			action: textLink(h, { tone: "muted", className: "text-2xs", onClick: Message.ClickedRetry() }, [
				"Try again",
			]),
			subline: "Couldn't load the spend limit",
		})
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
			? textLink(
					h,
					{ tone: "muted", className: "text-2xs", onClick: Message.ClickedSpendAndModels() },
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
	const confirmed = openConfirmed(findings).length
	const toValidate = openNeedsValidation(findings).length
	// Gated reads as words; still loading is the same still block as every other placeholder.
	const unknown: Html | string | null =
		state._tag === "Ready" ? null : state._tag === "Gated" ? "Admins only" : placeholder(h, "h-7 w-10")
	const running = runningRuns(model).length
	const coverage = coverageAcross(model)
	// Until its reads land, an empty sum is unknown, not "not mapped".
	const coverageUnknown = coverage === null && !coverageSettled(model)
	return statRail(h, { columns: 4, className: NARROW_TWO_COLUMNS }, [
		statRailItem(h, {
			eyebrow: "Open leads",
			value: unknown ?? String(confirmed + toValidate),
			compact: true,
			subline: unknown === null ? leadsLine(confirmed, toValidate) : undefined,
		}),
		statRailItem(h, {
			eyebrow: "Covered",
			value: coverageUnknown
				? placeholder(h, "h-7 w-10")
				: coverage === null
					? "Not mapped"
					: `${coverage.closed} / ${coverage.total}`,
			hint: coverage === null ? undefined : "units",
			valueClassName: coverage === null && !coverageUnknown ? "text-base" : undefined,
			compact: true,
			subline:
				coverage === null
					? coverageUnknown
						? undefined
						: "no run has mapped a repository yet"
					: h.span(
							[h.Class("flex flex-col gap-1.5")],
							[
								meter(h, {
									value: coverage.closed,
									max: coverage.total,
									label: `${coverage.closed} of ${coverage.total} units closed`,
								}),
								`latest run of ${coverage.targets} ${coverage.targets === 1 ? "target" : "targets"}`,
							],
						),
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

/** "3 high, 1 unverified": how many of a severity's count are estimates. */
const countTitle = (
	count: number,
	severity: "critical" | "high" | "medium" | "low",
	unverified: ReadonlyArray<SecurityAuditFinding>,
): string => {
	const estimated = unverified.filter((finding) => bucketOf(finding) === severity).length
	const base = `${count} ${SECURITY_SEVERITY_LABEL[severity].toLowerCase()}`
	return estimated === 0 ? base : `${base}, ${estimated} unverified`
}

/** Open leads by severity as dots (estimates included), then the unscored ones still to validate. */
const leadCounts = (h: H, findings: ReadonlyArray<SecurityAuditFinding>): Html => {
	const open = [...openConfirmed(findings), ...openNeedsValidation(findings)]
	const counts = countByBucket(open)
	const unverified = open.filter(isUnverified)
	const toValidate = counts.needs_validation
	return h.span(
		[h.Class("flex items-center gap-2.5 font-mono text-xs tabular-nums")],
		[
			...(["critical", "high", "medium", "low"] as const).map((severity) =>
				h.span(
					[
						h.Key(severity),
						// Lifted over the row link so its title still shows on hover.
						h.Class(cn("inline-flex items-center gap-1.5", ROW_LINK_LIFT)),
						h.Title(countTitle(counts[severity], severity, unverified)),
					],
					[
						statusDot(h, {
							tone: "custom",
							size: "lg",
							className: SECURITY_SEVERITY_FILL[severity],
						}),
						String(counts[severity]),
					],
				),
			),
			...(toValidate === 0
				? []
				: [
						h.span(
							[
								h.Key("to-validate"),
								h.Class("whitespace-nowrap font-sans text-muted-foreground"),
							],
							[`+${toValidate} to validate`],
						),
					]),
		],
	)
}

/** Names the open-findings dots once, in the panel header, so each row stays four numbers. */
const severityLegend = (h: H): Html =>
	h.span(
		[h.Class("flex items-center gap-2.5"), h.AriaHidden(true)],
		(["critical", "high", "medium", "low"] as const).map((severity) =>
			h.span(
				[h.Key(severity), h.Class("inline-flex items-center gap-1.5")],
				[
					statusDot(h, { tone: "custom", className: SECURITY_SEVERITY_FILL[severity] }),
					SECURITY_SEVERITY_LABEL[severity],
				],
			),
		),
	)

const lastRunCell = (h: H, model: Model, run: SecurityAuditRun | undefined): Html => {
	if (run === undefined) return h.span([h.Class("text-xs text-muted-foreground")], ["No run yet"])
	const detail = isLive(run)
		? `running for ${formatElapsed(model.nowMs - run.startedAt)}`
		: run.status === "failed"
			? (run.error ?? "the audit could not start")
			: run.status === "incomplete"
				? stopSummaryOf(run.incompleteReason)
				: `${formatElapsed((run.finishedAt ?? run.startedAt) - run.startedAt)} · ${refLabel(run.sourceRef)}`
	return h.div(
		[h.Class("flex min-w-0 flex-col items-start gap-1")],
		[
			runStatusBadge(h, run),
			h.span([h.Class(cn("max-w-56 truncate text-xs text-muted-foreground", ROW_LINK_LIFT)), h.Title(detail)], [detail]),
		],
	)
}

const coverageCell = (h: H, model: Model, run: SecurityAuditRun | undefined): Html => {
	const detail = run === undefined ? null : latestDetailOf(model, run.id)
	if (run === undefined || detail === null || detail.unitTotal === 0)
		return h.span(
			[h.Class("whitespace-nowrap text-xs text-muted-foreground")],
			[run === undefined ? "" : "not mapped"],
		)
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

/**
 * One span per part, so the ellipsis lands inside a word (the last part's) rather than after a
 * separator's space.
 */
const metaLine = (h: H, parts: ReadonlyArray<string>, title: string): Html =>
	h.span(
		[h.Class(cn("flex max-w-72 min-w-0 overflow-hidden text-xs text-muted-foreground", ROW_LINK_LIFT)), h.Title(title)],
		parts.map((part, index) =>
			h.span(
				[
					h.Key(String(index)),
					h.Class(
						cn("whitespace-pre", index === parts.length - 1 ? "min-w-0 truncate" : "shrink-0"),
					),
				],
				[index === 0 ? part : ` · ${part}`],
			),
		),
	)

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
	// Model first so a long scope path is what truncates.
	const parts = [targetModelOf(model, target), ...targetParts(target)].filter((part) => part !== null)
	const meta = parts.join(" · ")
	return tableRow(
		h,
		[
			tableCell(h, [
				// The name is the row's link, stretched over the whole row.
				rowLink(
					h,
					{ href, className: "flex min-w-0 items-center gap-2.5" },
					[
						icon(h, "GithubIcon", { size: 16, className: "shrink-0 text-muted-foreground" }),
						h.span(
							[h.Class("flex min-w-0 flex-col")],
							[
								repositoryName(h, target.repository, "text-sm font-medium"),
								metaLine(h, parts, meta),
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
							? h.span([h.Class("text-xs text-muted-foreground")], ["No completed run"])
							: leadCounts(h, findings)
						: leadCounts(h, findings)
					: h.span(
							[h.Class("text-xs text-muted-foreground")],
							[findings === "forbidden" ? "Admins only" : ""],
						),
			]),
			tableCell(h, [coverageCell(h, model, run)], "text-right"),
			tableCell(
				h,
				[run === undefined ? "" : formatUsd(runTotalUsd(run))],
				"text-right font-mono tabular-nums",
			),
			tableCell(
				h,
				[icon(h, "ChevronRightIcon", { size: 14, className: "text-muted-foreground" })],
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
				[h.Class("flex items-center gap-4 text-xs text-muted-foreground")],
				[severityLegend(h), "One audit runs per target at a time"],
			),
		}),
		table(h, { ariaLabel: "Audit targets" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Repository"]),
					tableHead(h, ["Last run"]),
					tableHead(h, ["Open leads"]),
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
					h.Class("flex items-center gap-4 px-4 py-3 hover:bg-surface-sunken active:bg-surface-sunken"),
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
				[h.Class("w-16 shrink-0")],
				[
					isUnverified(finding)
						? findingBadge(h, finding)
						: finding.verdict === "needs_validation"
							? h.span([h.Class("text-xs text-muted-foreground normal-case")], ["To validate"])
							: finding.overallSeverity === null
								? ""
								: securitySeverityBadge(h, finding.overallSeverity),
				],
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
	model: Model,
	findings: ReadonlyArray<SecurityAuditFinding>,
	targets: ReadonlyArray<SecurityAuditTarget>,
): Html => {
	const rows = openLeads(findings).slice(0, 5)
	const coverage = coverageAcross(model)
	return rows.length === 0
		? emptyMessage(h, {}, [
				coverage === null
					? "No open leads yet"
					: `No open leads. The latest runs closed ${coverage.closed} of ${coverage.total} units.`,
			])
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

/** Open leads: confirmed by severity, then the ones to validate. */
const topFindingsPanel = (h: H, model: Model, targets: ReadonlyArray<SecurityAuditTarget>): Html => {
	const state = findingsStateOf(model)
	const body =
		state._tag === "Gated"
			? gateState(h, state.gate, "m-4")
			: state._tag === "Failed"
				? errorState(h, {
						failure: state.failure,
						title: "Couldn't load findings",
						variant: "inline",
						onRetry: Message.ClickedRetry(),
					})
				: state._tag === "Loading"
					? placeholderRows(h, 4)
					: topFindingsList(h, model, state.findings, targets)
	return panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Open leads",
			action: textLink(
				h,
				{
					tone: "muted",
					className: "text-xs",
					href: hrefOf(AppRoute.SecurityFindings({ search: {} })),
				},
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
			? emptyMessage(h, {}, ["No runs yet. Start one from a target."])
			: h.ul(
					[h.Class("divide-y")],
					runs.map((run) => {
						const repository =
							targets.find((target) => target.id === run.targetId)?.repository ??
							"Removed target"
						const note = isLive(run)
							? `running for ${formatElapsed(model.nowMs - run.startedAt)}`
							: run.status === "failed"
								? "could not finish"
								: run.status === "incomplete"
									? stopSummaryOf(run.incompleteReason)
									: formatElapsed((run.finishedAt ?? run.startedAt) - run.startedAt)
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
								h.span([h.Class("shrink-0")], [runStatusBadge(h, run)]),
								h.span(
									[h.Class("w-20 text-right font-mono text-sm tabular-nums")],
									[formatUsd(runTotalUsd(run))],
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
		[h.Class("relative")],
		[
			h.div(
				[h.Class("grid grid-cols-2 gap-px md:grid-cols-4")],
				Array.from({ length: 4 }, () => placeholder(h, "h-24")),
			),
			skeletonSlowNote(h, "absolute inset-x-0 top-full mt-1"),
		],
	),
	placeholder(h, "h-64 w-full"),
]

export const overviewBody = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.matchData(model.targets.data, {
		onEmpty: () => overviewLoading(h),
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: "Couldn't load audit targets",
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
