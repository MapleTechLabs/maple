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
	isSeenThisHour,
	type RuntimeEntry,
	runtimeEntries,
	runtimeLabelOf,
	runtimeTotals,
	sdkLabelOf,
} from "./derive"
import { Message, type Model } from "./model"
import { telemetryLoading } from "./view-exposure"

// The Runtimes tab: each service's runtime and version against its release cycle, worst first.

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
			subline: "reporting spans this week",
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
		statRailItem(h, {
			eyebrow: "No version reported",
			value: String(totals.noVersion),
			compact: true,
			subline: `${services(totals.noVersion)} Maple cannot check`,
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
			".",
		],
	)

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
			return [
				totalsRail(h, entries),
				...(hasNoVersion ? [noVersionNote(h)] : []),
				h.div(
					[h.Class("flex flex-col gap-2")],
					[runtimesTable(h, entries, model.nowMs, timeZone), footnote(h)],
				),
			]
		},
	})
