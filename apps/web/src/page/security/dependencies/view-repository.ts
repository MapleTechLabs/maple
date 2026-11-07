import type {
	DependencyFindingView,
	DependencyProductionCoverage,
	DependencyScanRepository,
} from "@maple/domain/http"
import { displayAdvisoryId } from "@maple/domain/package-advisories"
import { countLabel, formatRate } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { pressable } from "@maple/views/ui/pressable"
import { panel } from "@maple/views/ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { WIDE_COLUMN } from "../kit/layout"
import { advisorySeverityBadge } from "../kit/parts"
import { digestOf, planSummaryOf, RELATION_LABEL, type UpgradeStep, upgradePlanOf } from "./derive"
import { Message, type Model } from "./model"
import { findingsSection, notRunningLabel, productionScanStates, readEverything } from "./view-findings"
import { paneTabs, scopeSwitcher } from "./view-pane"
import { lockfileIssue, scanButton, scanState, scanSummary, severityTally } from "./view-repositories"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// One repository's pane: its latest scan, then its open findings as the package bumps that clear
// them (the first to make on top) or as the advisories table.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const muted = (h: H, text: string, className?: string): Html =>
	typography(h, { size: "xs", tone: "muted", className }, [text])

const advisoryNames = (findings: ReadonlyArray<DependencyFindingView>): string =>
	Arr.join(
		Arr.map(findings, (finding) =>
			displayAdvisoryId({ id: finding.advisoryId, aliases: finding.aliases }),
		),
		", ",
	)

const bumpCell = (h: H, step: UpgradeStep): Html =>
	vstack(h, { gap: "0", shrink: true, as: "span", className: "max-w-72" }, [
		typography(h, { size: "sm", mono: true, truncate: true, attributes: [h.Title(step.packageName)] }, [
			step.packageName,
		]),
		hstack(h, { gap: "1.5", shrink: true, as: "span" }, [
			typography(
				h,
				{
					size: "xs",
					mono: true,
					numeric: true,
					tone: "muted",
					truncate: true,
					attributes: [h.Title(Arr.join(step.installed, ", "))],
				},
				[Arr.join(step.installed, ", ")],
			),
			...(step.target === null
				? []
				: [
						typography(h, { size: "xs", tone: "faint", attributes: [h.AriaHidden(true)] }, ["→"]),
						typography(
							h,
							{
								size: "xs",
								mono: true,
								numeric: true,
								tone: "foreground",
								className: "shrink-0",
							},
							[step.target],
						),
					]),
		]),
	])

const clearsCell = (h: H, step: UpgradeStep): Html =>
	vstack(h, { gap: "0", as: "span" }, [
		typography(
			h,
			{ size: "sm", className: "whitespace-nowrap", attributes: [h.Title(advisoryNames(step.fixes))] },
			[step.target === null ? "No fix yet" : countLabel(step.fixes.length, "advisory", "advisories")],
		),
		...(step.unfixed.length === 0 || step.target === null
			? []
			: [muted(h, `${step.unfixed.length} with no fix yet`)]),
	])

const runningCell = (h: H, step: UpgradeStep, notRunning: string): Html => {
	const [busiest] = step.services
	return busiest === undefined
		? muted(h, notRunning)
		: vstack(
				h,
				{
					gap: "0",
					shrink: true,
					as: "span",
					className: "max-w-48",
					attributes: [h.Title(Arr.join(step.services, ", "))],
				},
				[
					typography(h, { size: "sm", truncate: true }, [
						step.services.length > 1 ? `${busiest} +${step.services.length - 1}` : busiest,
					]),
					muted(h, `${formatRate(step.productionSpans)} spans/day`, "tabular-nums"),
				],
			)
}

/** The bump's package, a toggle that lists the advisories it clears under the row. */
const bumpToggle = (h: H, step: UpgradeStep, isExpanded: boolean): Html =>
	pressable(
		h,
		{
			onClick: Message.ClickedPackage({ key: step.key }),
			className: "flex min-w-0 items-center gap-2 text-left",
			attributes: [h.AriaExpanded(isExpanded)],
		},
		[
			icon(h, isExpanded ? "ChevronDownIcon" : "ChevronRightIcon", {
				size: 12,
				className: "shrink-0 text-muted-foreground",
			}),
			bumpCell(h, step),
		],
	)

/**
 * The advisories a bump clears, then the ones with no fix yet; each opens its finding's sheet. The
 * list is zero-width at minimum full-width, so a long summary truncates instead of widening the table.
 */
const stepAdvisories = (h: H, step: UpgradeStep): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					vstack(
						h,
						{ gap: "0.5", as: "ul", className: "w-0 min-w-full py-1 pl-28" },
						Arr.map([...step.fixes, ...step.unfixed], (finding) =>
							h.li(
								[h.Key(finding.id)],
								[
									pressable(
										h,
										{
											onClick: Message.ClickedFinding({ findingId: finding.id }),
											className:
												"flex w-full min-w-0 items-center gap-3 rounded-sm px-2 py-1 text-left text-xs hover:bg-surface-raised active:bg-surface-raised",
										},
										[
											h.span(
												[h.Class("w-20 shrink-0")],
												[advisorySeverityBadge(h, finding.severity)],
											),
											typography(h, { mono: true, className: "w-44 shrink-0" }, [
												displayAdvisoryId({
													id: finding.advisoryId,
													aliases: finding.aliases,
												}),
											]),
											typography(
												h,
												{
													tone: "muted",
													truncate: true,
													className: "min-w-0 flex-1",
												},
												[finding.summary],
											),
											typography(
												h,
												{ tone: "muted", mono: true, className: "shrink-0" },
												[
													finding.fixedIn === null
														? "No fix yet"
														: `Fixed in ${finding.fixedIn}`,
												],
											),
										],
									),
								],
							),
						),
					),
				],
				"bg-surface-sunken whitespace-normal",
				[h.Colspan(6)],
			),
		],
		undefined,
		[h.Key(`${step.key}/advisories`)],
	)

const stepRow = (h: H, step: UpgradeStep, notRunning: string, isExpanded: boolean): Html =>
	tableRow(
		h,
		[
			tableCell(h, [advisorySeverityBadge(h, step.severity)], "w-24"),
			tableCell(h, [bumpToggle(h, step, isExpanded)]),
			tableCell(h, [clearsCell(h, step)], WIDE_COLUMN),
			tableCell(h, [runningCell(h, step, notRunning)], WIDE_COLUMN),
			tableCell(h, [muted(h, RELATION_LABEL[step.relation])], "hidden md:table-cell"),
			tableCell(
				h,
				[
					vstack(
						h,
						{
							shrink: true,
							as: "span",
							className: "max-w-56",
							attributes: [h.Title(Arr.join(step.lockfiles, "\n"))],
						},
						[
							middleTruncate(h, {
								text: step.lockfiles[0] ?? "",
								tail: Math.min(24, step.lockfiles[0]?.length ?? 0),
								mono: true,
								className: typographyClass({ size: "xs", tone: "muted" }),
							}),
							...(step.lockfiles.length > 1
								? [muted(h, `+${countLabel(step.lockfiles.length - 1, "lockfile")}`)]
								: []),
						],
					),
				],
				"hidden lg:table-cell",
			),
		],
		undefined,
		[h.Key(step.key)],
	)

/** "3 upgrades clear 5 of 6 open advisories": the plan before its rows. */
const planLine = (plan: ReadonlyArray<UpgradeStep>): string => {
	const summary = planSummaryOf(plan)
	const clears =
		summary.upgrades === 0
			? `None of ${countLabel(summary.open, "open advisory", "open advisories")} has a fixed version yet.`
			: `${countLabel(summary.upgrades, "upgrade")} ${summary.upgrades === 1 ? "clears" : "clear"} ${summary.fixable} of ${countLabel(summary.open, "open advisory", "open advisories")}.`
	if (summary.upgrades === 0 || summary.unfixed === 0) return clears
	return `${clears} ${summary.unfixed} still ${summary.unfixed === 1 ? "waits" : "wait"} on a fix upstream.`
}

/** Clean only when the latest scan read every lockfile; an empty plan says no more than what was read. */
const emptyPlanLine = (repository: DependencyScanRepository): string =>
	repository.latestScan === null
		? "Not scanned yet, so there is nothing to plan."
		: readEverything(repository)
			? "No open advisories in this repository's latest scan"
			: "No open advisories in what the latest scan could read."

const planPanel = (
	h: H,
	model: Model,
	repository: DependencyScanRepository,
	plan: ReadonlyArray<UpgradeStep>,
	notRunning: string,
): Html =>
	panel(
		h,
		{ className: "overflow-hidden" },
		plan.length === 0
			? [emptyMessage(h, {}, [emptyPlanLine(repository)])]
			: [
					typography(h, { size: "xs", tone: "muted", as: "p", className: stripClass("head") }, [
						planLine(plan),
					]),
					table(h, { variant: "bare", ariaLabel: `Upgrade plan for ${repository.fullName}` }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Worst"]),
								tableHead(h, ["Upgrade"]),
								tableHead(h, ["Clears"], WIDE_COLUMN),
								tableHead(h, ["Running in"], WIDE_COLUMN),
								tableHead(h, ["Relation"], "hidden md:table-cell"),
								tableHead(h, ["Lockfile"], "hidden lg:table-cell"),
							]),
						]),
						tableBody(
							h,
							Arr.flatMap(plan, (step) => {
								const isExpanded = model.expandedPackages.includes(step.key)
								return [
									stepRow(h, step, notRunning, isExpanded),
									...(isExpanded ? [stepAdvisories(h, step)] : []),
								]
							}),
						),
					]),
				],
	)

/** Beside the switcher: the tracked branch, the GitHub link and Scan now. */
const repositoryActions = (h: H, model: Model, repository: DependencyScanRepository): ReadonlyArray<Html> => [
	typography(h, { size: "xs", tone: "muted", mono: true, className: "shrink-0" }, [
		repository.trackedBranch,
	]),
	textLink(
		h,
		{
			tone: "muted",
			href: repository.htmlUrl,
			attributes: [
				h.Target("_blank"),
				h.Rel("noopener noreferrer"),
				h.AriaLabel(`Open ${repository.fullName} on GitHub`),
			],
		},
		[icon(h, "GithubIcon", { size: 14 })],
	),
	hstack(h, { gap: "2", grow: true, justify: "end" }, [
		...scanState(h, repository.latestScan),
		scanButton(h, model, repository),
	]),
]

/** What the latest scan read, and what kept it from reading everything. */
const scanDetail = (h: H, repository: DependencyScanRepository, clock: Clock): Html => {
	const scan = repository.latestScan
	const issues = Arr.filter(scan?.lockfiles ?? [], (lockfile) => lockfile.status !== "parsed")
	return vstack(h, { gap: "1.5" }, [
		scan === null ? muted(h, "Scanned on the next push, or now.") : scanSummary(h, scan, clock),
		...(scan?.error === null || scan?.error === undefined
			? []
			: [typography(h, { size: "xs", tone: "error", as: "p" }, [scan.error])]),
		...(issues.length === 0
			? []
			: [
					vstack(
						h,
						{ gap: "1", as: "ul" },
						Arr.map(issues, (lockfile) => lockfileIssue(h, lockfile)),
					),
				]),
	])
}

/** One repository: its scan, its open findings by severity, then its upgrade plan or advisories. */
export const repositoryPane = (
	h: H,
	model: Model,
	state: Readonly<{
		repository: DependencyScanRepository
		repositories: ReadonlyArray<DependencyScanRepository>
		findings: ReadonlyArray<DependencyFindingView>
		production: DependencyProductionCoverage
	}>,
	clock: Clock,
): ReadonlyArray<Html> => {
	const { repository, production } = state
	const digest = digestOf(state.repositories, state.findings)
	const own = digest.statsOf(repository.id).findings
	const plan = upgradePlanOf(own)
	const notRunning = notRunningLabel(production, productionScanStates([repository]).get(repository.id))
	return [
		scopeSwitcher(h, model, digest, repositoryActions(h, model, repository)),
		scanDetail(h, repository, clock),
		severityTally(h, own),
		paneTabs(h, repository.id, model.pane, {
			summary: { label: "Upgrade plan", count: planSummaryOf(plan).upgrades },
			repositories: null,
			advisories: planSummaryOf(plan).open,
		}),
		model.pane === "summary"
			? planPanel(h, model, repository, plan, notRunning)
			: findingsSection(h, model, state, clock),
	]
}
