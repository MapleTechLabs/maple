import type { DependencyLockfileStatus, DependencyScanLockfile } from "@maple/domain/dependency-scan"
import type {
	DependencyFindingView,
	DependencyScanRepository,
	DependencyScanSummary,
} from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import {
	ROW_LINK_LIFT,
	rowLink,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "../../../ui/table"
import { relativeTime } from "../../kit/relative-time"
import { repositoryName } from "../kit/parts"
import {
	isScanPending,
	openFindingsOf,
	openSeverityCounts,
	planSummaryOf,
	runningServicesOf,
	SEVERITY_LABEL,
	shortSha,
	upgradePlanOf,
} from "./derive"
import { SEVERITY_FILL } from "../../errors/kit/severity"
import { Message, type Model } from "./model"

// Each connected repository as a row: its latest scan, open findings by severity, the upgrades
// that clear them and what production runs. A row opens the repository's breakdown.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** Said when the scanner left no message of its own. */
const LOCKFILE_FALLBACK = {
	parsed: "",
	unsupported: "This lockfile format is not supported yet.",
	too_large: "Too large to scan.",
	failed: "Could not be read.",
	skipped: "Past the lockfiles a scan reads.",
} satisfies Record<DependencyLockfileStatus, string>

const LOCKFILE_STATUS_LABEL = {
	parsed: "Parsed",
	unsupported: "Unsupported",
	too_large: "Too large",
	failed: "Failed",
	skipped: "Skipped",
} satisfies Record<DependencyLockfileStatus, string>

const lockfileIssue = (h: H, lockfile: DependencyScanLockfile): Html =>
	h.li(
		[h.Key(lockfile.path), h.Class("flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs")],
		[
			h.span([h.Class("font-mono text-foreground")], [lockfile.path]),
			badge(h, { variant: lockfile.status === "failed" ? "warn" : "muted" }, [
				LOCKFILE_STATUS_LABEL[lockfile.status],
			]),
			h.span(
				[h.Class("min-w-0 text-muted-foreground")],
				[lockfile.message ?? LOCKFILE_FALLBACK[lockfile.status]],
			),
		],
	)

/** What the scan's time stands for: a failed scan read nothing, so it is not "Scanned". */
const SCAN_SUMMARY_LABEL = {
	running: "Scan started",
	completed: "Scanned",
	failed: "Last attempt",
} satisfies Record<DependencyScanSummary["status"], string>

const dot = (h: H): Html => h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["·"])

const scanSummary = (h: H, scan: DependencyScanSummary, clock: Clock): Html =>
	h.span(
		[
			h.Class(
				cn(
					"flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground",
					ROW_LINK_LIFT,
				),
			),
		],
		[
			SCAN_SUMMARY_LABEL[scan.status],
			relativeTime(h, {
				value: scan.finishedAt ?? scan.startedAt,
				nowMs: clock.nowMs,
				timeZone: clock.timeZone,
				variant: "orDate",
				tooltip: "title",
			}),
			dot(h),
			h.span([h.Class("font-mono"), h.Title(scan.commitSha)], [shortSha(scan.commitSha)]),
			dot(h),
			countLabel(scan.lockfiles.length, "lockfile"),
			dot(h),
			countLabel(scan.packageCount, "package"),
		],
	)

export const scanButton = (h: H, model: Model, repository: DependencyScanRepository): Html => {
	const isRequesting = model.requestingScans.includes(repository.id)
	const isQueued = !isRequesting && isScanPending(model, repository.id)
	const isRunning = repository.latestScan?.status === "running"
	return button(
		h,
		{
			variant: "outline",
			size: "sm",
			isLoading: isRequesting,
			isDisabled: isQueued || isRunning,
			className: ROW_LINK_LIFT,
			attributes: [h.OnClick(Message.ClickedScanNow({ repositoryId: repository.id }))],
		},
		[isQueued ? "Scan queued" : isRunning ? "Scanning" : "Scan now"],
	)
}

const scanState = (h: H, scan: DependencyScanSummary | null): ReadonlyArray<Html> =>
	scan === null
		? [badge(h, { variant: "muted" }, ["Not scanned yet"])]
		: scan.status === "failed"
			? [badge(h, { variant: "crit" }, ["Scan failed"])]
			: []

export const repositoryHref = (repositoryId: string | null): string =>
	hrefOf(AppRoute.SecurityDependencies({ search: repositoryId === null ? {} : { repo: repositoryId } }))

const muted = (h: H, text: string): Html => h.span([h.Class("text-xs text-muted-foreground")], [text])

const RANKED = ["critical", "high", "medium", "low"] as const

/** Open findings by severity as dots, the overview's targets read the same way. */
const severityCounts = (h: H, findings: ReadonlyArray<DependencyFindingView>): Html => {
	const counts = openSeverityCounts(findings)
	return h.span(
		[h.Class("flex items-center gap-2.5 font-mono text-xs tabular-nums")],
		[
			...RANKED.map((severity) =>
				h.span(
					[
						h.Key(severity),
						h.Class(
							cn(
								"inline-flex items-center gap-1.5",
								counts[severity] === 0 && "text-foreground-faint",
								ROW_LINK_LIFT,
							),
						),
						h.Title(`${counts[severity]} ${SEVERITY_LABEL[severity].toLowerCase()}`),
					],
					[
						statusDot(h, {
							tone: "custom",
							size: "lg",
							className: SEVERITY_FILL[severity],
						}),
						String(counts[severity]),
					],
				),
			),
			...(counts.unknown === 0
				? []
				: [
						h.span(
							[h.Key("unrated"), h.Class("whitespace-nowrap font-sans text-muted-foreground")],
							[`+${counts.unknown} unrated`],
						),
					]),
		],
	)
}

/** How many bumps clear the open findings, and how many have no fix to bump to. */
const planCell = (h: H, findings: ReadonlyArray<DependencyFindingView>): Html => {
	const plan = planSummaryOf(upgradePlanOf(findings))
	if (plan.open === 0) return muted(h, "Nothing to fix")
	return h.span(
		[h.Class("flex flex-col")],
		[
			h.span(
				[h.Class("whitespace-nowrap text-sm")],
				plan.upgrades === 0
					? ["No fix yet"]
					: [
							`${countLabel(plan.upgrades, "upgrade")} ${plan.upgrades === 1 ? "clears" : "clear"} ${plan.fixable}`,
						],
			),
			...(plan.unfixed === 0 || plan.upgrades === 0
				? []
				: [muted(h, `${plan.unfixed} with no fix yet`)]),
		],
	)
}

const productionCell = (h: H, repository: DependencyScanRepository): Html => {
	const services = runningServicesOf(repository)
	const [first] = services
	return first === undefined
		? muted(h, "Not seen running")
		: h.span(
				[h.Class(cn("flex min-w-0 max-w-40 flex-col", ROW_LINK_LIFT)), h.Title(services.join(", "))],
				[
					h.span([h.Class("truncate text-sm")], [first]),
					...(services.length > 1
						? [muted(h, `+${countLabel(services.length - 1, "service")}`)]
						: []),
				],
			)
}

const repositoryRow = (
	h: H,
	model: Model,
	repository: DependencyScanRepository,
	findings: ReadonlyArray<DependencyFindingView>,
	isFocused: boolean,
	clock: Clock,
): Html => {
	const scan = repository.latestScan
	const issues = (scan?.lockfiles ?? []).filter((lockfile) => lockfile.status !== "parsed")
	const open = openFindingsOf(findings, repository.id)
	// Findings from an earlier scan still count; with none, say why the cells are empty.
	const emptyNote =
		open.length > 0 || scan?.status === "completed"
			? null
			: scan === null
				? "No scan yet"
				: scan.status === "running"
					? "Scanning"
					: "No completed scan"
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex min-w-0 max-w-xl flex-col gap-1")],
						[
							h.span(
								[h.Class("flex min-w-0 items-center gap-2")],
								[
									icon(h, "GithubIcon", {
										size: 14,
										className: "shrink-0 text-muted-foreground",
									}),
									// The name is the row's link, stretched over the whole row.
									rowLink(
										h,
										{
											href: repositoryHref(repository.id),
											className: "min-w-0 text-sm font-medium",
											attributes: isFocused ? [h.AriaCurrent("page")] : [],
										},
										[repositoryName(h, repository.fullName)],
									),
									h.span(
										[h.Class("shrink-0 font-mono text-xs text-muted-foreground")],
										[repository.trackedBranch],
									),
									h.a(
										[
											h.Href(repository.htmlUrl),
											h.Target("_blank"),
											h.Rel("noopener noreferrer"),
											h.AriaLabel(`Open ${repository.fullName} on GitHub`),
											h.Class(
												cn(
													"shrink-0 text-muted-foreground hover:text-foreground active:text-foreground",
													ROW_LINK_LIFT,
												),
											),
										],
										[icon(h, "ExternalLinkIcon", { size: 12 })],
									),
								],
							),
							scan === null
								? muted(h, "Scanned on the next push, or now.")
								: scanSummary(h, scan, clock),
							...(scan?.error === null || scan?.error === undefined
								? []
								: [h.p([h.Class("text-xs text-severity-error")], [scan.error])]),
							...(issues.length === 0
								? []
								: [
										h.ul(
											[h.Class(cn("flex flex-col gap-1", ROW_LINK_LIFT))],
											issues.map((lockfile) => lockfileIssue(h, lockfile)),
										),
									]),
						],
					),
				],
				"w-full whitespace-normal align-top",
			),
			tableCell(h, [emptyNote === null ? severityCounts(h, open) : muted(h, emptyNote)], "align-top"),
			tableCell(h, [emptyNote === null ? planCell(h, open) : muted(h, "")], "align-top"),
			tableCell(h, [productionCell(h, repository)], "hidden md:table-cell align-top"),
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex items-center justify-end gap-2")],
						[...scanState(h, scan), scanButton(h, model, repository)],
					),
				],
				"align-top text-right",
			),
		],
		cn(isFocused && "bg-surface-strong"),
		[h.Key(repository.id)],
	)
}

export const repositoriesPanel = (
	h: H,
	model: Model,
	repositories: ReadonlyArray<DependencyScanRepository>,
	findings: ReadonlyArray<DependencyFindingView>,
	focusedId: string | null,
	clock: Clock,
): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Repositories",
			action: h.span(
				[h.Class("text-xs text-muted-foreground")],
				["Select a repository for its upgrade plan"],
			),
		}),
		table(h, { variant: "bare", ariaLabel: "Repositories" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Repository"]),
					tableHead(h, ["Open"]),
					tableHead(h, ["Fix plan"]),
					tableHead(h, ["Running in"], "hidden md:table-cell"),
					tableHead(h, [h.span([h.Class("sr-only")], ["Scan"])], "text-right"),
				]),
			]),
			tableBody(
				h,
				repositories.map((repository) =>
					repositoryRow(h, model, repository, findings, repository.id === focusedId, clock),
				),
			),
		]),
	])
