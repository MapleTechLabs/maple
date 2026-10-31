import {
	ADVISORY_SEVERITIES,
	type AdvisorySeverity,
	isUrgentSeverity,
	type RuntimeAdvisory,
} from "@maple/domain/runtime-advisories"
import { RUNTIME_PRODUCTS } from "@maple/domain/runtime-posture"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { panel, panelHeader } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { textLink } from "../../../ui/text-link"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { NARROW_TWO_COLUMNS } from "../kit/layout"
import {
	type CriticalUpgrade,
	criticalUpgrades,
	isSeenThisHour,
	type RuntimeEntry,
	runtimeEntries,
	runtimeLabelOf,
	runtimeTotals,
	sdkLabelOf,
} from "./derive"
import { Message, type Model } from "./model"
import { telemetryLoading } from "./view-exposure"

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
				detail: [
					posture.eolFrom === null ? null : `since ${posture.eolFrom}`,
					`cycle ${posture.cycle}`,
				]
					.filter((part) => part !== null)
					.join(" · "),
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

const statusCell = (h: H, entry: RuntimeEntry): Html => {
	const mark = markOf(entry)
	return h.div(
		[
			h.Class("flex min-w-0 flex-col items-start gap-1"),
			...(mark.title === undefined ? [] : [h.Title(mark.title)]),
		],
		[
			badge(h, { variant: mark.variant }, [mark.label]),
			...(mark.detail === null
				? []
				: [h.span([h.Class("whitespace-nowrap text-xs text-muted-foreground")], [mark.detail])]),
		],
	)
}

const runtimeCell = (h: H, entry: RuntimeEntry): Html =>
	h.span(
		[h.Class("inline-flex items-baseline gap-1.5")],
		[
			runtimeLabelOf(entry),
			...(entry.row.runtimeVersion === ""
				? []
				: [
						h.span(
							[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
							[entry.row.runtimeVersion],
						),
					]),
		],
	)

const SEVERITY_VARIANT = {
	critical: "crit",
	high: "warn",
	medium: "muted",
	low: "muted",
	unknown: "muted",
} as const satisfies Record<AdvisorySeverity, Mark["variant"]>

const severityCounts = (counts: Record<AdvisorySeverity, number>): string =>
	ADVISORY_SEVERITIES.filter((severity) => counts[severity] > 0)
		.map((severity) => `${counts[severity]} ${severity}`)
		.join(" · ")

const notScannedReason = (posture: RuntimeEntry["posture"]): string => {
	switch (posture.status) {
		case "no_version":
			return "This service reports no runtime version to check"
		case "emulated": {
			const label = RUNTIME_PRODUCTS[posture.product].label
			return `This service reports the Node.js version ${label} emulates, not its own; send ${label}'s version as process.runtime.version`
		}
		default:
			return "Maple has no vulnerability data for this runtime"
	}
}

const vulnerabilitiesCell = (h: H, entry: RuntimeEntry): Html => {
	const vulnerabilities = entry.vulnerabilities
	switch (vulnerabilities.status) {
		case "not_covered":
			return h.span(
				[h.Class("text-xs text-muted-foreground"), h.Title(notScannedReason(entry.posture))],
				["Not scanned"],
			)
		case "not_checked":
			return h.span(
				[
					h.Class("text-xs text-muted-foreground"),
					h.Title(
						"Not read on this visit: each visit checks the 96 busiest versions and reads up to 24 new ones",
					),
				],
				["Not checked yet"],
			)
		case "unavailable":
			return h.span([h.Class("text-xs text-muted-foreground")], ["Unavailable"])
		case "checked": {
			const summary = vulnerabilities.summary
			if (summary.worst === null)
				return h.span([h.Class("text-xs text-muted-foreground")], ["None known"])
			const rest = summary.total - summary.counts[summary.worst]
			return h.div(
				[h.Class("flex min-w-0 flex-col items-start gap-1"), h.Title(severityCounts(summary.counts))],
				[
					badge(h, { variant: SEVERITY_VARIANT[summary.worst] }, [
						`${summary.counts[summary.worst]} ${summary.worst}`,
					]),
					...(rest === 0
						? []
						: [
								h.span(
									[h.Class("whitespace-nowrap text-xs text-muted-foreground")],
									[`${rest} more`],
								),
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
			action: h.span([h.Class("text-xs text-muted-foreground")], ["Needs attention first"]),
		}),
		table(h, { ariaLabel: "Service runtimes" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Service"]),
					tableHead(h, ["Runtime"]),
					tableHead(h, ["Status"]),
					tableHead(h, ["Vulnerabilities"]),
					tableHead(h, ["SDK"]),
					tableHead(h, ["Last seen"]),
				]),
			]),
			tableBody(
				h,
				entries.map((entry) =>
					tableRow(
						h,
						[
							tableCell(h, [
								h.span(
									[h.Class("flex min-w-0 flex-col")],
									[
										h.span([h.Class("truncate font-medium")], [entry.row.service]),
										...(entry.row.environment === ""
											? []
											: [
													h.span(
														[h.Class("truncate text-xs text-muted-foreground")],
														[entry.row.environment],
													),
												]),
									],
								),
							]),
							tableCell(h, [runtimeCell(h, entry)]),
							tableCell(h, [statusCell(h, entry)]),
							tableCell(h, [vulnerabilitiesCell(h, entry)]),
							tableCell(h, [sdkLabelOf(entry.row)], "text-xs text-muted-foreground"),
							tableCell(h, [
								isSeenThisHour(entry.row.lastSeen, nowMs)
									? h.span(
											[h.Class("whitespace-nowrap text-xs text-muted-foreground")],
											["This hour"],
										)
									: relativeTime(h, {
											value: entry.row.lastSeen,
											nowMs,
											timeZone,
											variant: "orDate",
											tooltip: "title",
											className: "whitespace-nowrap text-xs text-muted-foreground",
										}),
							]),
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
	h.p(
		[h.Class("text-xs text-muted-foreground")],
		[
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
		],
	)

// CRITICAL UPGRADES

const ADVISORIES_SHOWN = 3

const UPGRADES_COPY =
	"These runtime versions have known critical or high severity vulnerabilities. The version shown is the lowest that fixes all of them that have a fix."

const advisoryRow = (h: H, advisory: RuntimeAdvisory): Html =>
	h.li(
		[h.Class("flex min-w-0 items-baseline gap-3")],
		[
			textLink(
				h,
				{
					className: "shrink-0 font-mono text-xs",
					href: advisory.url,
					attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
				},
				[advisory.id],
			),
			badge(h, { variant: SEVERITY_VARIANT[advisory.severity], className: "shrink-0" }, [
				advisory.severity,
			]),
			h.span(
				[h.Class("min-w-0 flex-1 truncate text-muted-foreground"), h.Title(advisory.summary ?? "")],
				[advisory.summary ?? "No summary published"],
			),
			...(advisory.fixedIn === null
				? []
				: [
						h.span(
							[
								h.Class(
									"shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground",
								),
							],
							[`fixed in ${advisory.fixedIn}`],
						),
					]),
		],
	)

const upgradeAdvice = (upgrade: CriticalUpgrade): string => {
	const { upgradeTo, unfixed } = upgrade.summary
	const advice = upgradeTo === null ? "No fixed release yet" : `Upgrade to ${upgradeTo} or later`
	return unfixed === 0 || upgradeTo === null ? advice : `${advice} · ${unfixed} without a fix yet`
}

const upgradeItem = (h: H, upgrade: CriticalUpgrade): Html => {
	const urgent = upgrade.advisories.filter((advisory) => isUrgentSeverity(advisory.severity))
	const hidden = upgrade.summary.total - Math.min(urgent.length, ADVISORIES_SHOWN)
	const isEndOfLife = upgrade.entry.posture.status === "end_of_life"
	return h.li(
		[h.Class("flex flex-col gap-2 py-3"), h.Key(upgrade.key)],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1")],
				[
					h.span(
						[h.Class("flex min-w-0 flex-wrap items-baseline gap-x-2")],
						[
							h.span(
								[h.Class("font-medium")],
								[`${runtimeLabelOf(upgrade.entry)} ${upgrade.entry.row.runtimeVersion}`],
							),
							h.span(
								[h.Class("truncate text-xs text-muted-foreground")],
								[upgrade.services.join(", ")],
							),
						],
					),
					h.span(
						[h.Class("flex items-center gap-2 text-sm")],
						[
							h.span(
								[h.Class("text-xs text-muted-foreground")],
								[severityCounts(upgrade.summary.counts)],
							),
							h.span([h.Class("font-medium")], [upgradeAdvice(upgrade)]),
						],
					),
				],
			),
			...(isEndOfLife
				? [
						h.p(
							[h.Class("text-xs text-severity-error")],
							[
								"This release line is end of life and gets no further fixes: move to a supported one.",
							],
						),
					]
				: []),
			h.ul(
				[h.Class("flex flex-col gap-1.5 text-sm")],
				urgent.slice(0, ADVISORIES_SHOWN).map((advisory) => advisoryRow(h, advisory)),
			),
			...(hidden > 0
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[`and ${hidden} more known for this version`],
						),
					]
				: []),
		],
	)
}

const upgradesPanel = (h: H, upgrades: ReadonlyArray<CriticalUpgrade>): Html =>
	panel(h, { className: "overflow-hidden border-severity-error-a3" }, [
		panelHeader(h, {
			className: "bg-severity-error-a1",
			title: h.span(
				[h.Class("flex items-center gap-2")],
				[
					icon(h, "CircleWarningIcon", { size: 16, className: "shrink-0 text-severity-error" }),
					upgrades.length === 1
						? "1 runtime version to upgrade now"
						: `${upgrades.length} runtime versions to upgrade now`,
				],
			),
		}),
		h.p([h.Class("max-w-3xl px-4 pt-3 pb-1 font-prose text-sm text-muted-foreground")], [UPGRADES_COPY]),
		h.ul(
			[h.Class("divide-y divide-border px-4 pb-1")],
			upgrades.map((upgrade) => upgradeItem(h, upgrade)),
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
							"This tab lists the runtime each service reports through ",
							inlineCode(h, {}, ["process.runtime.name"]),
							" and ",
							inlineCode(h, {}, ["process.runtime.version"]),
							". Rows appear as spans arrive.",
						],
					),
				]),
			]),
		],
		"rounded-md border md:py-16",
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
			const hasNoVersion = entries.some((entry) => entry.posture.status === "no_version")
			const upgrades = criticalUpgrades(entries)
			return [
				totalsRail(h, entries),
				...(upgrades.length > 0 ? [upgradesPanel(h, upgrades)] : []),
				...(hasNoVersion ? [noVersionNote(h)] : []),
				h.div(
					[h.Class("flex flex-col gap-2")],
					[runtimesTable(h, entries, model.nowMs, timeZone), footnote(h)],
				),
			]
		},
	})
