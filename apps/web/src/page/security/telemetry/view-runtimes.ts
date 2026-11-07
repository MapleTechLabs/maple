import {
	ADVISORY_SEVERITIES,
	type AdvisorySeverity,
	isUrgentSeverity,
	type RuntimeAdvisory,
} from "@maple/domain/runtime-advisories"
import { RUNTIME_PRODUCTS } from "@maple/domain/runtime-posture"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { NARROW_TWO_COLUMNS, ROOMY_COLUMN, WIDE_COLUMN } from "../kit/layout"
import { advisorySeverityBadge } from "../kit/parts"
import {
	type CriticalUpgrade,
	criticalUpgrades,
	currentEntries,
	isSeenThisHour,
	type RuntimeEntry,
	runtimeEntries,
	runtimeLabelOf,
	runtimeTotals,
	sdkLabelOf,
} from "./derive"
import { Message, type Model } from "./model"
import { telemetryLoading } from "./view-exposure"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

// The Runtimes tab: versions with critical CVEs to upgrade now, then each service's runtime and
// version against its release cycle and known vulnerabilities, worst first.

type H = HtmlBuilder<Message>

const BEHIND_HINT = "Patch releases often carry security fixes."

type Mark = Readonly<{
	label: string
	variant: "crit" | "warn" | "ok" | "muted"
	detail: string | null
	title?: string
}>

const markOf = (entry: RuntimeEntry): Mark => {
	const posture = entry.posture
	switch (posture.status) {
		case "end_of_life":
			return {
				label: "End of life",
				variant: "crit",
				detail: Arr.join(
					Arr.filter(
						[
							posture.eolFrom === null ? null : `since ${posture.eolFrom}`,
							`cycle ${posture.cycle}`,
						],
						(part) => part !== null,
					),
					" · ",
				),
			}
		case "behind":
			return {
				label: "Update available",
				variant: "warn",
				detail: posture.latest === null ? null : `latest ${posture.latest}`,
				title: BEHIND_HINT,
			}
		case "supported":
			return { label: "Supported", variant: "ok", detail: null }
		case "no_version":
			return { label: "No version reported", variant: "muted", detail: null }
		case "unknown_cycle":
			return { label: "Unrecognized release", variant: "muted", detail: null }
		case "emulated":
			return {
				label: "Not checked",
				variant: "muted",
				detail: "reports a Node.js compatibility version",
				title: "Bun and Deno report the Node.js version they are compatible with, not their own.",
			}
		case "catalog_unavailable":
			return { label: "Release data unavailable", variant: "muted", detail: null }
		case "untracked":
			return { label: "Not tracked", variant: "muted", detail: null }
	}
}

const REPLACED_MARK: Mark = {
	label: "Replaced",
	variant: "muted",
	detail: "a newer version took over",
	title: "This version stopped reporting after another one of this service started. It counts toward no totals.",
}

const statusCell = (h: H, entry: RuntimeEntry): Html => {
	const mark = entry.replaced ? REPLACED_MARK : markOf(entry)
	return h.div(
		[
			h.Class(vstackClass({ gap: "1", align: "start", shrink: true })),
			...(mark.title === undefined ? [] : [h.Title(mark.title)]),
		],
		[
			badge(h, { variant: mark.variant }, [mark.label]),
			...(mark.detail === null
				? []
				: [
						typography(h, { size: "xs", tone: "muted", className: "whitespace-nowrap" }, [
							mark.detail,
						]),
					]),
		],
	)
}

const runtimeCell = (h: H, entry: RuntimeEntry): Html =>
	hstack(h, { gap: "1.5", align: "baseline", inline: true, as: "span" }, [
		runtimeLabelOf(entry),
		...(entry.row.runtimeVersion === ""
			? []
			: [
					typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
						entry.row.runtimeVersion,
					]),
				]),
	])

const severityCounts = (counts: Record<AdvisorySeverity, number>): string =>
	Arr.join(
		Arr.map(
			Arr.filter(ADVISORY_SEVERITIES, (severity) => counts[severity] > 0),
			(severity) => `${counts[severity]} ${severity}`,
		),
		" · ",
	)

const notScannedReason = ({ posture, row }: RuntimeEntry): string => {
	switch (posture.status) {
		case "no_version":
			return "This service reports no runtime version to check"
		case "emulated": {
			const label = RUNTIME_PRODUCTS[posture.product].label
			return `This service reports the Node.js version ${label} emulates, not its own; send ${label}'s version as process.runtime.version`
		}
		default:
			// Every tracked runtime has an advisory source, so what is left is untracked.
			return Str.trim(row.runtimeName) === ""
				? "This service reports no runtime: set process.runtime.name and process.runtime.version"
				: "Maple does not track versions of this runtime"
	}
}

const vulnerabilitiesCell = (h: H, entry: RuntimeEntry): Html => {
	const vulnerabilities = entry.vulnerabilities
	switch (vulnerabilities.status) {
		case "not_covered":
			return typography(
				h,
				{ size: "xs", tone: "muted", attributes: [h.Title(notScannedReason(entry))] },
				["Not scanned"],
			)
		case "not_checked":
			return typography(
				h,
				{
					size: "xs",
					tone: "muted",
					attributes: [
						h.Title(
							"Not read on this visit: each visit checks the 96 busiest versions and reads up to 24 new ones",
						),
					],
				},
				["Not checked yet"],
			)
		case "unavailable":
			return typography(h, { size: "xs", tone: "muted" }, ["Unavailable"])
		case "checked": {
			const summary = vulnerabilities.summary
			if (summary.worst === null) return typography(h, { size: "xs", tone: "muted" }, ["None known"])
			// History, not a finding: no alarm colour on a version no longer running.
			if (entry.replaced)
				return typography(h, { size: "xs", tone: "muted" }, [severityCounts(summary.counts)])
			const rest = summary.total - summary.counts[summary.worst]
			return vstack(
				h,
				{
					gap: "1",
					align: "start",
					shrink: true,
					attributes: [h.Title(severityCounts(summary.counts))],
				},
				[
					hstack(h, { gap: "1.5", align: "center", as: "span", className: "whitespace-nowrap" }, [
						advisorySeverityBadge(h, summary.worst),
						typography(h, { size: "xs", mono: true, numeric: true }, [
							String(summary.counts[summary.worst]),
						]),
					]),
					...(rest === 0
						? []
						: [
								typography(h, { size: "xs", tone: "muted", className: "whitespace-nowrap" }, [
									`${rest} more`,
								]),
							]),
				],
			)
		}
	}
}

const runtimesTable = (h: H, entries: ReadonlyArray<RuntimeEntry>, nowMs: number, timeZone: string): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Runtimes by service",
			action: typography(h, { size: "xs", tone: "muted" }, ["Needs attention first"]),
		}),
		table(h, { ariaLabel: "Service runtimes" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Service"]),
					tableHead(h, ["Runtime"], WIDE_COLUMN),
					tableHead(h, ["Status"], WIDE_COLUMN),
					tableHead(h, ["Vulnerabilities"], WIDE_COLUMN),
					tableHead(h, ["SDK"], ROOMY_COLUMN),
					tableHead(h, ["Last seen"], WIDE_COLUMN),
				]),
			]),
			tableBody(
				h,
				Arr.map(entries, (entry) =>
					tableRow(
						h,
						[
							tableCell(h, [
								vstack(h, { shrink: true, as: "span" }, [
									typography(h, { weight: "medium", truncate: true }, [entry.row.service]),
									// Phones drop the runtime, status and vulnerability columns, so they ride under the service.
									h.span([h.Class("text-sm sm:hidden")], [runtimeCell(h, entry)]),
									h.span(
										[
											h.Class(
												"flex flex-wrap items-start gap-x-3 gap-y-1 pt-1 sm:hidden",
											),
										],
										[statusCell(h, entry), vulnerabilitiesCell(h, entry)],
									),
									...(entry.row.environment === ""
										? []
										: [
												typography(h, { size: "xs", tone: "muted", truncate: true }, [
													entry.row.environment,
												]),
											]),
								]),
							]),
							tableCell(h, [runtimeCell(h, entry)], WIDE_COLUMN),
							tableCell(h, [statusCell(h, entry)], WIDE_COLUMN),
							tableCell(h, [vulnerabilitiesCell(h, entry)], WIDE_COLUMN),
							tableCell(
								h,
								[sdkLabelOf(entry.row)],
								cn(typographyClass({ size: "xs", tone: "muted" }), ROOMY_COLUMN),
							),
							tableCell(
								h,
								[
									isSeenThisHour(entry.row.lastSeen, nowMs)
										? typography(
												h,
												{ size: "xs", tone: "muted", className: "whitespace-nowrap" },
												["This hour"],
											)
										: relativeTime(h, {
												value: entry.row.lastSeen,
												nowMs,
												timeZone,
												variant: "orDate",
												className: typographyClass({
													size: "xs",
													tone: "muted",
													className: "whitespace-nowrap",
												}),
											}),
								],
								WIDE_COLUMN,
							),
						],
						undefined,
						[
							h.Key(
								`${entry.row.service}|${entry.row.environment}|${entry.row.runtimeName}|${entry.row.runtimeVersion}|${entry.row.sdkName}|${entry.row.sdkVersion}`,
							),
						],
					),
				),
			),
		]),
	])

const totalsRail = (h: H, entries: ReadonlyArray<RuntimeEntry>): Html => {
	const totals = runtimeTotals(entries)
	const services = (value: number) => (value === 1 ? "service" : "services")
	return statRail(h, { columns: 4, className: NARROW_TWO_COLUMNS }, [
		statRailItem(h, {
			eyebrow: "Services",
			value: String(totals.services),
			compact: true,
			subline:
				totals.noVersion > 0
					? `${totals.noVersion} without a runtime version`
					: "reporting spans this week",
		}),
		statRailItem(h, {
			eyebrow: "Upgrade now",
			value: String(totals.urgent),
			tone: totals.urgent > 0 ? "crit" : undefined,
			compact: true,
			subline: `${services(totals.urgent)} with a critical or high CVE`,
		}),
		statRailItem(h, {
			eyebrow: "End of life",
			value: String(totals.endOfLife),
			tone: totals.endOfLife > 0 ? "crit" : undefined,
			compact: true,
			subline: `${services(totals.endOfLife)} on an unsupported release`,
		}),
		statRailItem(h, {
			eyebrow: "Update available",
			value: String(totals.behind),
			tone: totals.behind > 0 ? "warn" : undefined,
			compact: true,
			subline: `${services(totals.behind)} behind the latest patch`,
		}),
	])
}

const noVersionNote = (h: H): Html =>
	alert(h, { variant: "info", role: "status" }, [
		icon(h, "CircleInfoIcon"),
		alertTitle(h, ["Some services report no runtime version"]),
		alertDescription(h, [
			h.p(
				[],
				[
					"They send no ",
					inlineCode(h, {}, ["process.runtime.version"]),
					" resource attribute. Most OpenTelemetry SDKs set it automatically; otherwise set it in the service's resource attributes.",
				],
			),
		]),
	])

const footnote = (h: H): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p" }, [
		"Release data from ",
		textLink(
			h,
			{
				tone: "muted",
				className: "underline",
				href: "https://endoflife.date",
				attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
			},
			["endoflife.date"],
		),
		", vulnerabilities from ",
		textLink(
			h,
			{
				tone: "muted",
				className: "underline",
				href: "https://osv.dev",
				attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
			},
			["OSV.dev"],
		),
		" and, for Bun and Deno, their GitHub security advisories.",
	])

// CRITICAL UPGRADES

const ADVISORIES_SHOWN = 3

const UPGRADES_COPY =
	"These runtime versions have known critical or high severity vulnerabilities. The version shown is the lowest that fixes all of them that have a fix."

const advisoryRow = (h: H, advisory: RuntimeAdvisory): Html =>
	hstack(h, { gap: "3", align: "baseline", shrink: true, as: "li" }, [
		textLink(
			h,
			{
				className: "shrink-0 font-mono text-xs",
				href: advisory.url,
				attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
			},
			[advisory.id],
		),
		advisorySeverityBadge(h, advisory.severity, "shrink-0"),
		h.span(
			[h.Class("min-w-0 flex-1 truncate text-muted-foreground"), h.Title(advisory.summary ?? "")],
			[advisory.summary ?? "No summary published"],
		),
		...(advisory.fixedIn === null
			? []
			: [
					typography(
						h,
						{
							size: "xs",
							tone: "muted",
							mono: true,
							numeric: true,
							className: "shrink-0 whitespace-nowrap",
						},
						[`fixed in ${advisory.fixedIn}`],
					),
				]),
	])

const upgradeAdvice = (upgrade: CriticalUpgrade): string => {
	const { upgradeTo, unfixed } = upgrade.summary
	const advice = upgradeTo === null ? "No fixed release yet" : `Upgrade to ${upgradeTo} or later`
	return unfixed === 0 || upgradeTo === null ? advice : `${advice} · ${unfixed} without a fix yet`
}

const upgradeItem = (h: H, upgrade: CriticalUpgrade): Html => {
	const urgent = Arr.filter(upgrade.advisories, (advisory) => isUrgentSeverity(advisory.severity))
	const hidden = upgrade.summary.total - Math.min(urgent.length, ADVISORIES_SHOWN)
	const isEndOfLife = upgrade.entry.posture.status === "end_of_life"
	return vstack(h, { gap: "2", as: "li", className: "py-3", attributes: [h.Key(upgrade.key)] }, [
		hstack(h, { align: "baseline", justify: "between", wrap: true, className: "gap-x-4 gap-y-1" }, [
			hstack(h, { align: "baseline", wrap: true, shrink: true, as: "span", className: "gap-x-2" }, [
				typography(h, { weight: "medium" }, [
					`${runtimeLabelOf(upgrade.entry)} ${upgrade.entry.row.runtimeVersion}`,
				]),
				typography(h, { size: "xs", tone: "muted", truncate: true }, [
					Arr.join(upgrade.services, ", "),
				]),
			]),
			hstack(h, { gap: "2", align: "center", as: "span", className: "text-sm" }, [
				typography(h, { size: "xs", tone: "muted" }, [severityCounts(upgrade.summary.counts)]),
				typography(h, { weight: "medium" }, [upgradeAdvice(upgrade)]),
			]),
		]),
		...(isEndOfLife
			? [
					typography(h, { size: "xs", tone: "error", as: "p" }, [
						"This release line is end of life and gets no further fixes: move to a supported one.",
					]),
				]
			: []),
		vstack(
			h,
			{ gap: "1.5", as: "ul", className: typographyClass({ size: "sm" }) },
			Arr.map(urgent.slice(0, ADVISORIES_SHOWN), (advisory) => advisoryRow(h, advisory)),
		),
		...(hidden > 0
			? [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						`and ${hidden} more known for this version`,
					]),
				]
			: []),
	])
}

const upgradesPanel = (h: H, upgrades: ReadonlyArray<CriticalUpgrade>): Html =>
	panel(h, { className: "overflow-hidden border-severity-error-a3" }, [
		panelHeader(h, {
			className: "bg-severity-error-a1",
			title: hstack(h, { gap: "2", as: "span" }, [
				icon(h, "CircleWarningIcon", { size: 16, className: "shrink-0 text-severity-error" }),
				upgrades.length === 1
					? "1 runtime version to upgrade now"
					: `${upgrades.length} runtime versions to upgrade now`,
			]),
		}),
		h.p([h.Class("max-w-3xl px-4 pt-3 pb-1 font-prose text-sm text-muted-foreground")], [UPGRADES_COPY]),
		h.ul(
			[h.Class("divide-y divide-border px-4 pb-1")],
			Arr.map(upgrades, (upgrade) => upgradeItem(h, upgrade)),
		),
	])

const runtimesEmpty = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "MicrochipIcon")]),
				emptyTitle(h, ["No runtimes reported yet"]),
				emptyDescription(h, [
					h.span(
						[],
						[
							"This page lists the runtime each service reports through ",
							inlineCode(h, {}, ["process.runtime.name"]),
							" and ",
							inlineCode(h, {}, ["process.runtime.version"]),
							". Rows appear as spans arrive.",
						],
					),
				]),
			]),
		],
		emptyFrameClass("dashed"),
	)

export const runtimesBody = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> =>
	AsyncData.matchData(model.runtimes.data, {
		onEmpty: () => telemetryLoading(h),
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: "Couldn't load service runtimes",
				onRetry: Message.ClickedRetry(),
			}),
		],
		onData: (runtimes) => {
			const entries = runtimeEntries(runtimes)
			if (entries.length === 0) return [runtimesEmpty(h)]
			const hasNoVersion = Arr.some(
				currentEntries(entries),
				(entry) => entry.posture.status === "no_version",
			)
			const upgrades = criticalUpgrades(entries)
			return [
				totalsRail(h, entries),
				...(upgrades.length > 0 ? [upgradesPanel(h, upgrades)] : []),
				...(hasNoVersion ? [noVersionNote(h)] : []),
				vstack(h, { gap: "2" }, [runtimesTable(h, entries, model.nowMs, timeZone), footnote(h)]),
			]
		},
	})
