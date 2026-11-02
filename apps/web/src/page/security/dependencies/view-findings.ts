import type {
	DependencyFindingView,
	DependencyProductionCoverage,
	DependencyScanRepository,
} from "@maple/domain/http"
import { displayAdvisoryId } from "@maple/domain/package-advisories"
import { countLabel, formatRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { listFooter } from "@maple/views/ui/list-footer"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { pressable } from "@maple/views/ui/pressable"
import * as Select from "@maple/views/ui/select"
import * as SelectView from "@maple/views/ui/select-view"
import {
	clickableRowClass,
	laneTableCell,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { listToolbar } from "../../kit/list-toolbar"
import { relativeTime } from "../../kit/relative-time"
import { ROOMY_COLUMN, WIDE_COLUMN } from "../kit/layout"
import { advisorySeverityBadge, repositoryName } from "../kit/parts"
import {
	filteredFindings,
	RELATION_LABEL,
	repositoryFilterOf,
	STATUS_FILTER_LABEL,
	STATUS_FILTERS,
	statusFilterOf,
} from "./derive"
import { Message, type Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { vstack } from "@maple/views/ui/stack"

// The findings table: one row per advisory on a package in a lockfile, worst first as the server
// sorts them, under a status and a repository filter.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

export const advisoryHref = (advisoryId: string): string =>
	`https://osv.dev/vulnerability/${encodeURIComponent(advisoryId)}`

export const advisoryLink = (h: H, finding: DependencyFindingView, className?: string): Html =>
	textLink(
		h,
		{
			className: cn(typographyClass({ size: "xs", mono: true }), className),
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

export const item = (value: string, label: string): SelectView.SelectEntry => ({
	_tag: "Item",
	item: { value, label },
})

export const filterSelect = (
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
			className: "h-7 w-auto min-w-28 text-xs",
			renderValue: (value) => [
				h.span([h.Class("text-muted-foreground")], [`${label} `]),
				renderValue(value),
			],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
		toParentMessage: wrap,
	})

const toolbar = (h: H, model: Model, findings: ReadonlyArray<DependencyFindingView>): Html => {
	const statusLabel = (value: string) =>
		STATUS_FILTER_LABEL[STATUS_FILTERS.find((status) => status === value) ?? "open"]
	return listToolbar(h, {
		framed: true,
		trailing: [
			filterSelect(
				h,
				model.statusSelect,
				STATUS_FILTERS.map((status) =>
					item(
						status,
						`${STATUS_FILTER_LABEL[status]} (${filteredFindings(findings, status, repositoryFilterOf(model)).length})`,
					),
				),
				"Status",
				statusLabel,
				(message) => Message.GotStatusSelectMessage({ message }),
			),
		],
	})
}

const muted = (h: H, text: string, className?: string): Html =>
	typography(h, { size: "xs", tone: "muted", className }, [text])

export type ProductionScanState = "running" | "unscanned" | "failed"

/** Repositories whose running commits are not all scanned: one scanning, one with no scan yet, or one failed. */
export const productionScanStates = (
	repositories: ReadonlyArray<DependencyScanRepository>,
): ReadonlyMap<string, ProductionScanState> =>
	new Map(
		repositories.flatMap((repository): ReadonlyArray<readonly [string, ProductionScanState]> => {
			const statuses = repository.runningCommits.map((commit) => commit.scanStatus)
			if (statuses.includes("running")) return [[repository.id, "running"]]
			// No scan row: queued from this read, or past the per-read cap, so nothing claims it is running.
			if (statuses.includes(null)) return [[repository.id, "unscanned"]]
			return statuses.includes("failed") ? [[repository.id, "failed"]] : []
		}),
	)

/** Spans a finding's running services served over the last day. */
export const productionSpans = (finding: DependencyFindingView): number =>
	finding.production.reduce((sum, service) => sum + service.spanCount, 0)

/**
 * What to say when no running service carries a package: a running commit not scanned yet may,
 * and "Not running" holds only when every running commit was read.
 */
export const notRunningLabel = (
	production: DependencyProductionCoverage,
	scan: ProductionScanState | undefined,
): string =>
	scan === "running"
		? "Scanning"
		: scan === "unscanned"
			? "Not scanned yet"
			: scan === "failed"
				? "Scan failed"
				: production.available && production.complete && production.linkedServices > 0
					? "Not running"
					: "Unknown"

/** The busiest service running the finding, and how many more; unknown without commit telemetry. */
const productionCell = (
	h: H,
	finding: DependencyFindingView,
	production: DependencyProductionCoverage,
	scans: ReadonlyMap<string, ProductionScanState>,
): Html => {
	const [busiest] = finding.production
	if (busiest === undefined) return muted(h, notRunningLabel(production, scans.get(finding.repositoryId)))
	const others = new Set(finding.production.map((service) => service.serviceName)).size - 1
	return h.span(
		[h.Class("flex min-w-0 max-w-48 flex-col")],
		[
			typography(h, { size: "sm", truncate: true, attributes: [h.Title(busiest.serviceName)] }, [
				others > 0 ? `${busiest.serviceName} +${others}` : busiest.serviceName,
			]),
			muted(h, `${formatRate(productionSpans(finding))} spans/day`, "tabular-nums"),
		],
	)
}

/**
 * Said when findings cannot be tied to what runs: no service reports the commit it was built from,
 * or none of those commits belongs to a connected repository.
 */
export const productionHint = (h: H, production: DependencyProductionCoverage): ReadonlyArray<Html> => {
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
	showRepository: boolean,
): Html => {
	const open = Message.ClickedFinding({ findingId: finding.id })
	return tableRow(
		h,
		[
			// A set-aside finding says so under its severity: the time column folds away beside the list.
			laneTableCell(
				h,
				isSelected,
				[
					vstack(h, { gap: "1", align: "start" }, [
						advisorySeverityBadge(h, finding.severity),
						...(finding.status === "open"
							? []
							: [badge(h, { variant: "meta" }, [STATUS_FILTER_LABEL[finding.status]])]),
					]),
				],
				"w-24",
			),
			tableCell(h, [
				pressable(
					h,
					{
						className:
							"flex min-w-0 max-w-72 flex-col items-start text-left focus-visible:underline focus-visible:outline-none",
						attributes: [h.OnClick(open, { propagation: "Stop" })],
					},
					[
						typography(
							h,
							{
								size: "sm",
								mono: true,
								truncate: true,
								attributes: [h.Title(versionsLabel(finding))],
							},
							[finding.packageName],
						),
						muted(
							h,
							`${finding.ecosystem} · ${finding.versions.join(", ")}`,
							typographyClass({ mono: true, truncate: true }),
						),
					],
				),
			]),
			tableCell(h, [advisoryLink(h, finding)], WIDE_COLUMN),
			tableCell(h, [productionCell(h, finding, production, scans)], WIDE_COLUMN),
			tableCell(h, [
				finding.fixedIn === null
					? muted(h, "No fix yet")
					: typography(h, { size: "xs", mono: true, numeric: true }, [finding.fixedIn]),
			]),
			tableCell(h, [muted(h, RELATION_LABEL[finding.relation])], ROOMY_COLUMN),
			tableCell(
				h,
				[
					h.span(
						[h.Class("flex min-w-0 max-w-64 flex-col")],
						[
							// Scoped to one repository, every row would repeat its name.
							...(showRepository
								? [
										typography(
											h,
											{
												size: "sm",
												truncate: true,
												attributes: [h.Title(finding.repositoryFullName)],
											},
											[repositoryName(h, finding.repositoryFullName)],
										),
									]
								: []),
							middleTruncate(h, {
								text: finding.lockfilePath,
								tail: Math.min(24, finding.lockfilePath.length),
								mono: true,
								className: typographyClass({ size: "xs", tone: "muted" }),
							}),
						],
					),
				],
				"hidden lg:table-cell",
			),
			tableCell(
				h,
				[
					relativeTime(h, {
						value: finding.createdAt,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						variant: "orDate",
						tooltip: "title",
						className: typographyClass({
							size: "xs",
							tone: "muted",
							className: "whitespace-nowrap",
						}),
					}),
				],
				cn("whitespace-nowrap text-right", ROOMY_COLUMN),
			),
		],
		clickableRowClass(isSelected),
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
	showRepository: boolean,
): Html =>
	table(h, { ariaLabel: "Vulnerable packages" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Severity"]),
				tableHead(h, ["Package"]),
				tableHead(h, ["Advisory"], WIDE_COLUMN),
				tableHead(h, ["In production"], WIDE_COLUMN),
				tableHead(h, ["Fixed in"]),
				tableHead(h, ["Relation"], ROOMY_COLUMN),
				tableHead(h, [showRepository ? "Location" : "Lockfile"], "hidden lg:table-cell"),
				tableHead(h, ["First seen"], cn("text-right", ROOMY_COLUMN)),
			]),
		]),
		tableBody(
			h,
			rows.map((finding) =>
				findingRow(h, finding, finding.id === selectedId, clock, production, scans, showRepository),
			),
		),
	])

const packagesChecked = (repositories: ReadonlyArray<DependencyScanRepository>): number =>
	repositories.reduce((sum, repository) => sum + (repository.latestScan?.packageCount ?? 0), 0)

/** A repository is only clean when its latest scan completed whole and read every lockfile it found. */
export const readEverything = (repository: DependencyScanRepository): boolean =>
	repository.latestScan?.status === "completed" &&
	repository.latestScan.error === null &&
	repository.latestScan.lockfiles.every((lockfile) => lockfile.status === "parsed")

/** Scanned and nothing open: a calm line, not an alarm. */
export const cleanState = (h: H, repositories: ReadonlyArray<DependencyScanRepository>): Html =>
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
	const footer = listFooter(h, {
		shown: Math.min(rows.length, model.shownRows),
		total: rows.length,
		noun: "findings",
		hasMore: rows.length > model.shownRows,
		onLoadMore: Message.ClickedShowMoreRows(),
	})
	const content =
		rows.length > 0
			? findingsTable(
					h,
					rows.slice(0, model.shownRows),
					model.selectedId,
					clock,
					production,
					productionScanStates(repositories),
					repositoryId === null,
				)
			: // Clean only when every repository's latest scan read its lockfiles; a failed or missing one is not a clean bill.
				status === "open" && repositoryId === null && repositories.every(readEverything)
				? cleanState(h, repositories)
				: h.div(
						[h.Class("p-4")],
						[
							filteredEmpty(h, {
								noun: "findings",
								className: emptyFrameClass("dashed"),
								description:
									status === "all"
										? ""
										: `Showing ${STATUS_FILTER_LABEL[status].toLowerCase()} findings only.`,
							}),
						],
					)
	return borderedBox(
		h,
		{ as: "section", overflow: "hidden", card: true, attributes: [h.AriaLabel("Vulnerable packages")] },
		[
			toolbar(h, model, findings),
			...productionHint(h, production),
			content,
			...(rows.length > 0 && footer !== null ? [footer] : []),
		],
	)
}
