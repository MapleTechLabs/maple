import type {
	DependencyFindingView,
	DependencyProductionCoverage,
	DependencyScanRepository,
} from "@maple/domain/http"
import { type AdvisorySeverity, displayAdvisoryId } from "@maple/domain/package-advisories"
import { countLabel, formatRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { middleTruncate } from "../../../ui/middle-truncate"
import * as Select from "../../../ui/select"
import * as SelectView from "../../../ui/select-view"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { textLink } from "../../../ui/text-link"
import { listToolbar } from "../../kit/list-toolbar"
import { nothingInWindow } from "../../kit/nothing-in-window"
import { relativeTime } from "../../kit/relative-time"
import { securitySeverityBadge } from "../kit/parts"
import {
	filteredFindings,
	matchesStatus,
	RELATION_LABEL,
	repositoryFilterOf,
	SEVERITY_LABEL,
	STATUS_FILTER_LABEL,
	STATUS_FILTERS,
	statusFilterOf,
} from "./derive"
import { Message, type Model } from "./model"

// The findings table: one row per advisory on a package in a lockfile, worst first as the server
// sorts them, under a status and a repository filter.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** The code audit's severity badge; an advisory with no score reads as "Unrated". */
export const dependencySeverityBadge = (h: H, severity: AdvisorySeverity, className?: string): Html =>
	severity === "unknown"
		? badge(h, { variant: "muted", className: cn("text-muted-foreground", className) }, [
				SEVERITY_LABEL.unknown,
			])
		: securitySeverityBadge(h, severity, className)

export const advisoryHref = (advisoryId: string): string =>
	`https://osv.dev/vulnerability/${encodeURIComponent(advisoryId)}`

export const advisoryLink = (h: H, finding: DependencyFindingView, className?: string): Html =>
	textLink(
		h,
		{
			className: cn("font-mono text-xs", className),
			href: advisoryHref(finding.advisoryId),
			attributes: [
				h.Target("_blank"),
				h.Rel("noopener noreferrer"),
				h.OnClick(Message.ClickedAdvisoryLink(), { propagation: "Stop" }),
			],
		},
		[displayAdvisoryId({ id: finding.advisoryId, aliases: finding.aliases })],
	)

export const versionsLabel = (finding: DependencyFindingView): string =>
	finding.versions.length === 0
		? finding.packageName
		: `${finding.packageName}@${finding.versions.join(", ")}`

const item = (value: string, label: string): SelectView.SelectEntry => ({
	_tag: "Item",
	item: { value, label },
})

const filterSelect = (
	h: H,
	select: Select.Model,
	entries: ReadonlyArray<SelectView.SelectEntry>,
	label: string,
	renderValue: (value: string) => string,
	wrap: (message: Select.Message) => Message,
): Html =>
	h.submodel({
		slotId: select.id,
		model: select,
		view: SelectView.view,
		viewInputs: {
			entries,
			size: "sm",
			ariaLabel: label,
			className: "h-7 w-auto min-w-28 text-xs",
			renderValue: (value) => [
				h.span([h.Class("text-muted-foreground")], [`${label} `]),
				renderValue(value),
			],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
		toParentMessage: wrap,
	})

const toolbar = (
	h: H,
	model: Model,
	findings: ReadonlyArray<DependencyFindingView>,
	repositories: ReadonlyArray<DependencyScanRepository>,
): Html => {
	const statusLabel = (value: string) =>
		STATUS_FILTER_LABEL[STATUS_FILTERS.find((status) => status === value) ?? "open"]
	const repositoryLabel = (value: string) =>
		repositories.find((repository) => repository.id === value)?.fullName ?? "All repositories"
	return listToolbar(h, {
		framed: true,
		leading: h.h2([h.Class("px-1 text-sm font-medium")], ["Vulnerable packages"]),
		trailing: [
			filterSelect(
				h,
				model.statusSelect,
				STATUS_FILTERS.map((status) =>
					item(
						status,
						`${STATUS_FILTER_LABEL[status]} (${findings.filter((finding) => matchesStatus(finding, status)).length})`,
					),
				),
				"Status",
				statusLabel,
				(message) => Message.GotStatusSelectMessage({ message }),
			),
			// One repository needs no repository filter.
			...(repositories.length < 2
				? []
				: [
						filterSelect(
							h,
							model.repositorySelect,
							[
								item("all", "All repositories"),
								...repositories.map((repository) => item(repository.id, repository.fullName)),
							],
							"Repository",
							repositoryLabel,
							(message) => Message.GotRepositorySelectMessage({ message }),
						),
					]),
		],
	})
}

const muted = (h: H, text: string, className?: string): Html =>
	h.span([h.Class(cn("text-xs text-muted-foreground", className))], [text])

type ProductionScanState = "pending" | "failed"

/** Repositories whose running commits are not all scanned: one still pending, or one whose scan failed. */
const productionScanStates = (
	repositories: ReadonlyArray<DependencyScanRepository>,
): ReadonlyMap<string, ProductionScanState> =>
	new Map(
		repositories.flatMap((repository): ReadonlyArray<readonly [string, ProductionScanState]> => {
			const statuses = repository.runningCommits.map((commit) => commit.scanStatus)
			if (statuses.some((status) => status === null || status === "running"))
				return [[repository.id, "pending"]]
			return statuses.includes("failed") ? [[repository.id, "failed"]] : []
		}),
	)

/** Spans a finding's running services served over the last day. */
export const productionSpans = (finding: DependencyFindingView): number =>
	finding.production.reduce((sum, service) => sum + service.spanCount, 0)

/** The busiest service running the finding, and how many more; unknown without commit telemetry. */
const productionCell = (
	h: H,
	finding: DependencyFindingView,
	production: DependencyProductionCoverage,
	scans: ReadonlyMap<string, ProductionScanState>,
): Html => {
	const [busiest] = finding.production
	// A running commit not scanned yet may carry the finding: no answer until its scan lands.
	const scan = scans.get(finding.repositoryId)
	if (busiest === undefined && scan !== undefined)
		return muted(h, scan === "pending" ? "Scanning" : "Scan failed")
	if (busiest === undefined)
		return muted(
			h,
			production.available && production.complete && production.linkedServices > 0
				? "Not running"
				: "Unknown",
		)
	const others = new Set(finding.production.map((service) => service.serviceName)).size - 1
	return h.span(
		[h.Class("flex min-w-0 max-w-48 flex-col")],
		[
			h.span(
				[h.Class("truncate text-sm"), h.Title(busiest.serviceName)],
				[others > 0 ? `${busiest.serviceName} +${others}` : busiest.serviceName],
			),
			muted(h, `${formatRate(productionSpans(finding))} spans/day`, "tabular-nums"),
		],
	)
}

/**
 * Said when findings cannot be tied to what runs: no service reports the commit it was built from,
 * or none of those commits belongs to a connected repository.
 */
const productionHint = (h: H, production: DependencyProductionCoverage): ReadonlyArray<Html> => {
	const text = !production.available
		? "Production traffic could not be read, so findings are ranked by severity alone."
		: production.runningServices === 0
			? "No service reports the commit it runs (vcs.ref.head.revision), so findings cannot be tied to production. Set it to rank them by traffic."
			: production.linkedServices === 0
				? "The commits your services run are not in a connected repository's tracked branch, so findings cannot be tied to production."
				: null
	return text === null
		? []
		: [h.p([h.Class("border-b bg-surface-sunken px-4 py-2 text-xs text-muted-foreground")], [text])]
}

const findingRow = (
	h: H,
	finding: DependencyFindingView,
	isSelected: boolean,
	clock: Clock,
	production: DependencyProductionCoverage,
	scans: ReadonlyMap<string, ProductionScanState>,
): Html => {
	const open = Message.ClickedFinding({ findingId: finding.id })
	return tableRow(
		h,
		[
			tableCell(h, [dependencySeverityBadge(h, finding.severity)], "w-24"),
			tableCell(h, [
				h.button(
					[
						h.Type("button"),
						h.OnClick(open, { propagation: "Stop" }),
						h.Class(
							"flex min-w-0 max-w-72 flex-col items-start text-left focus-visible:underline focus-visible:outline-none",
						),
					],
					[
						h.span(
							[h.Class("truncate font-mono text-sm"), h.Title(versionsLabel(finding))],
							[finding.packageName],
						),
						muted(
							h,
							`${finding.ecosystem} · ${finding.versions.join(", ")}`,
							"truncate font-mono",
						),
					],
				),
			]),
			tableCell(h, [advisoryLink(h, finding)]),
			tableCell(h, [productionCell(h, finding, production, scans)]),
			tableCell(h, [
				finding.fixedIn === null
					? muted(h, "No fix yet")
					: h.span([h.Class("font-mono text-xs tabular-nums")], [finding.fixedIn]),
			]),
			tableCell(h, [muted(h, RELATION_LABEL[finding.relation])], "hidden md:table-cell"),
			tableCell(
				h,
				[
					h.span(
						[h.Class("flex min-w-0 max-w-64 flex-col")],
						[
							h.span(
								[h.Class("truncate text-sm"), h.Title(finding.repositoryFullName)],
								[finding.repositoryFullName],
							),
							middleTruncate(h, {
								text: finding.lockfilePath,
								tail: Math.min(24, finding.lockfilePath.length),
								mono: true,
								className: "text-xs text-muted-foreground",
							}),
						],
					),
				],
				"hidden lg:table-cell",
			),
			tableCell(
				h,
				[
					...(finding.status === "open"
						? []
						: [
								badge(h, { variant: "meta", className: "mr-2" }, [
									STATUS_FILTER_LABEL[finding.status],
								]),
							]),
					relativeTime(h, {
						value: finding.createdAt,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						variant: "orDate",
						tooltip: "title",
						className: "whitespace-nowrap text-xs text-muted-foreground",
					}),
				],
				"whitespace-nowrap text-right",
			),
		],
		cn(
			"cursor-pointer hover:bg-surface-sunken active:bg-surface-sunken",
			isSelected && "bg-surface-strong",
		),
		[h.Key(finding.id), h.OnClick(open)],
	)
}

const findingsTable = (
	h: H,
	rows: ReadonlyArray<DependencyFindingView>,
	selectedId: string | null,
	clock: Clock,
	production: DependencyProductionCoverage,
	scans: ReadonlyMap<string, ProductionScanState>,
): Html =>
	table(h, { ariaLabel: "Vulnerable packages" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Severity"]),
				tableHead(h, ["Package"]),
				tableHead(h, ["Advisory"]),
				tableHead(h, ["In production"]),
				tableHead(h, ["Fixed in"]),
				tableHead(h, ["Relation"], "hidden md:table-cell"),
				tableHead(h, ["Location"], "hidden lg:table-cell"),
				tableHead(h, ["First seen"], "text-right"),
			]),
		]),
		tableBody(
			h,
			rows.map((finding) =>
				findingRow(h, finding, finding.id === selectedId, clock, production, scans),
			),
		),
	])

const packagesChecked = (repositories: ReadonlyArray<DependencyScanRepository>): number =>
	repositories.reduce((sum, repository) => sum + (repository.latestScan?.packageCount ?? 0), 0)

/** Scanned and nothing open: a calm line, not an alarm. */
const cleanState = (h: H, repositories: ReadonlyArray<DependencyScanRepository>): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "ShieldCheckIcon")]),
				emptyTitle(h, ["No known vulnerable packages"]),
				emptyDescription(h, [
					`The latest scans checked ${countLabel(packagesChecked(repositories), "package")} against OSV.dev. New advisories are matched on every scan.`,
				]),
			]),
		],
		"md:py-14",
	)

export const findingsSection = (
	h: H,
	model: Model,
	state: Readonly<{
		findings: ReadonlyArray<DependencyFindingView>
		repositories: ReadonlyArray<DependencyScanRepository>
		production: DependencyProductionCoverage
	}>,
	clock: Clock,
): Html => {
	const { findings, repositories, production } = state
	const status = statusFilterOf(model)
	const repositoryId = repositoryFilterOf(model)
	const rows = filteredFindings(findings, status, repositoryId)
	const content =
		rows.length > 0
			? findingsTable(h, rows, model.selectedId, clock, production, productionScanStates(repositories))
			: // Clean only when a scan has read something; a failed first scan is not a clean bill.
				status === "open" &&
				  repositoryId === null &&
				  repositories.some((repository) => repository.latestScan?.status === "completed")
				? cleanState(h, repositories)
				: h.div(
						[h.Class("p-4")],
						[
							nothingInWindow(h, {
								title: "No findings match",
								description:
									status === "all"
										? "No findings for these filters."
										: `No ${STATUS_FILTER_LABEL[status].toLowerCase()} findings for these filters.`,
							}),
						],
					)
	return h.section(
		[h.AriaLabel("Vulnerable packages"), h.Class("overflow-hidden rounded-md border bg-card")],
		[toolbar(h, model, findings, repositories), ...productionHint(h, production), content],
	)
}
