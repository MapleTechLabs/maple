import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { panel, panelHeader } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { textLink } from "../../../ui/text-link"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { NARROW_TWO_COLUMNS } from "../kit/layout"
import { placeholder } from "../kit/parts"
import { TIMELINE_BUCKET_SECONDS } from "./command"
import {
	type CatchAllService,
	type CategoryRow,
	catchAllServices,
	categoryLabelOf,
	categoryRows,
	exposedRows,
	exposureTotals,
	isExposedCapped,
	isExposureEmpty,
	SOURCES_SHOWN,
	timelineValues,
} from "./derive"
import { type Exposure, Message, type Model } from "./model"

// The Exposure tab: probe paths a service answered, the week's totals, categories and sources.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const lastSeen = (h: H, clock: Clock, value: string): Html =>
	relativeTime(h, {
		value,
		nowMs: clock.nowMs,
		timeZone: clock.timeZone,
		variant: "orDate",
		tooltip: "title",
		className: "whitespace-nowrap text-xs text-muted-foreground",
	})

const count = (value: number): string => formatNumber(value)

// EXPOSED PROBES

const EXPOSED_COPY =
	"A scanner asked for something that should never be public and the service answered with a 2xx. Check that the response does not contain it. Services that answer almost every path are listed separately as likely catch-all routes."

const exposedPanel = (h: H, clock: Clock, rows: Exposure["exposed"], capped: boolean): Html =>
	panel(h, { className: "overflow-hidden border-severity-error-a3" }, [
		panelHeader(h, {
			className: "bg-severity-error-a1",
			title: h.span(
				[h.Class("flex items-center gap-2")],
				[
					icon(h, "CircleWarningIcon", { size: 16, className: "shrink-0 text-severity-error" }),
					`${rows.length}${capped ? "+" : ""} probe ${rows.length === 1 && !capped ? "path" : "paths"} answered with a success`,
				],
			),
		}),
		h.p([h.Class("max-w-3xl px-4 pt-3 pb-1 font-prose text-sm text-muted-foreground")], [EXPOSED_COPY]),
		table(h, { ariaLabel: "Probe paths answered with a success" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Service"]),
					tableHead(h, ["Path"]),
					tableHead(h, ["Category"]),
					tableHead(h, ["Status"]),
					tableHead(h, ["Requests"], "text-right"),
					tableHead(h, ["Last seen"]),
					tableHead(h, [h.span([h.Class("sr-only")], ["Trace"])]),
				]),
			]),
			tableBody(
				h,
				rows.map((row) =>
					tableRow(
						h,
						[
							tableCell(h, [row.service], "font-medium"),
							tableCell(h, [
								h.span(
									[
										h.Class("block max-w-80 truncate font-mono text-xs"),
										h.Title(`${row.host}${row.path}`),
									],
									[h.span([h.Class("text-muted-foreground")], [row.host]), row.path],
								),
							]),
							tableCell(h, [categoryLabelOf(row.signature)], "text-xs text-muted-foreground"),
							tableCell(h, [
								badge(h, { variant: "crit", mono: true }, [String(row.httpStatus)]),
							]),
							tableCell(h, [count(row.requests)], "text-right font-mono tabular-nums"),
							tableCell(h, [lastSeen(h, clock, row.lastSeen)]),
							tableCell(
								h,
								row.sampleTraceId === ""
									? []
									: [
											textLink(
												h,
												{
													tone: "muted",
													className: "whitespace-nowrap text-xs",
													href: hrefOf(
														AppRoute.Trace({
															traceId: row.sampleTraceId,
															search: {},
														}),
													),
												},
												["Sample trace"],
											),
										],
								"text-right",
							),
						],
						undefined,
						[h.Key(`${row.service}|${row.host}|${row.path}|${row.httpStatus}`)],
					),
				),
			),
		]),
	])

// TOTALS

const totalsRail = (h: H, clock: Clock, exposure: Exposure): Html => {
	const totals = exposureTotals(exposure)
	const exposedCount = exposedRows(exposure).length
	const catchAllCount = catchAllServices(exposure).length
	const plus = isExposedCapped(exposure) ? "+" : ""
	return statRail(h, { columns: 4, className: NARROW_TWO_COLUMNS }, [
		statRailItem(h, {
			eyebrow: "Probe requests",
			value: count(totals.probeRequests),
			spark: timelineValues(exposure, clock.nowMs, TIMELINE_BUCKET_SECONDS, 28),
			subline: "paths only scanners ask for",
		}),
		statRailItem(h, {
			eyebrow: "Scanner requests",
			value: count(totals.scannerRequests),
			compact: true,
			subline: "named tools on ordinary paths",
		}),
		statRailItem(h, {
			eyebrow: "Sources",
			value: totals.isSourcesCapped ? `${SOURCES_SHOWN}+` : String(totals.sources),
			compact: true,
			subline: totals.isSourcesCapped
				? `client addresses, the ${SOURCES_SHOWN} most active listed`
				: "distinct client addresses",
		}),
		statRailItem(h, {
			eyebrow: "Services probed",
			value: String(totals.servicesProbed),
			compact: true,
			subline:
				exposedCount > 0
					? `${exposedCount}${plus} answered ${exposedCount === 1 && plus === "" ? "path" : "paths"}`
					: catchAllCount > 0
						? `${catchAllCount} likely catch-all ${catchAllCount === 1 ? "route" : "routes"}`
						: "none answered a sensitive probe",
		}),
	])
}

// CATCH-ALL ROUTES

const CATCH_ALL_COPY =
	"These services answer almost every probe path with a success, which usually means they serve the same page for any path. Their answered probes are left out above."

const catchAllPanel = (h: H, services: ReadonlyArray<CatchAllService>): Html =>
	panel(h, {}, [
		panelHeader(h, { title: "Likely catch-all routes" }),
		h.p(
			[h.Class("max-w-3xl px-4 pt-3 pb-1 font-prose text-sm text-muted-foreground")],
			[
				services.some((entry) => entry.sampleTraceId !== "")
					? `${CATCH_ALL_COPY} Open a sample trace to confirm nothing real is served.`
					: `${CATCH_ALL_COPY} Check one response to confirm nothing real is served.`,
			],
		),
		h.ul(
			[h.Class("divide-y divide-border px-4 pb-2 text-sm")],
			services.map((entry) =>
				h.li(
					[h.Class("flex items-center justify-between gap-4 py-2")],
					[
						h.span([h.Class("font-medium")], [entry.service]),
						h.span(
							[h.Class("flex items-center gap-4")],
							[
								h.span(
									[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
									[`${entry.answered} of ${entry.probed} sensitive probe paths answered`],
								),
								...(entry.sampleTraceId === ""
									? []
									: [
											textLink(
												h,
												{
													tone: "muted",
													className: "whitespace-nowrap text-xs",
													href: hrefOf(
														AppRoute.Trace({
															traceId: entry.sampleTraceId,
															search: {},
														}),
													),
												},
												["Sample trace"],
											),
										]),
							],
						),
					],
				),
			),
		),
	])

// CATEGORIES

/** Answered probes alarm only where a success means something leaked; WordPress probes do not. */
const answeredCell = (h: H, row: CategoryRow): Html => {
	const isAlarming = row.category?.critical === true && row.answered > 0
	return h.span(
		[
			h.Class(
				cn(
					"inline-flex items-center justify-end gap-1.5 font-mono tabular-nums",
					isAlarming ? "text-severity-error" : "text-muted-foreground",
				),
			),
		],
		[...(isAlarming ? [statusDot(h, { tone: "crit" })] : []), count(row.answered)],
	)
}

const categoriesPanel = (h: H, rows: ReadonlyArray<CategoryRow>): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Categories",
			action: h.span([h.Class("text-xs text-muted-foreground")], ["Answered counts 2xx responses"]),
		}),
		table(h, { ariaLabel: "Probe categories" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Category"]),
					tableHead(h, ["Requests"], "text-right"),
					tableHead(h, ["Answered"], "text-right"),
					tableHead(h, ["Services"], "text-right"),
					tableHead(h, ["Top signatures"]),
				]),
			]),
			tableBody(
				h,
				rows.map((row) =>
					tableRow(
						h,
						[
							tableCell(h, [row.label], "font-medium"),
							tableCell(h, [count(row.requests)], "text-right font-mono tabular-nums"),
							tableCell(h, [answeredCell(h, row)], "text-right"),
							tableCell(h, [String(row.services)], "text-right font-mono tabular-nums"),
							tableCell(h, [
								h.span(
									[h.Class("flex flex-wrap items-center gap-1.5")],
									row.topSignatures.map((signature) =>
										h.span(
											[
												h.Key(signature.signature),
												h.Title(`${count(signature.requests)} requests`),
											],
											[inlineCode(h, {}, [signature.signature])],
										),
									),
								),
							]),
						],
						undefined,
						[h.Key(row.key)],
					),
				),
			),
		]),
	])

// SOURCES

const sourcesPanel = (h: H, clock: Clock, sources: Exposure["sources"]): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Top sources",
			action: h.span([h.Class("text-xs text-muted-foreground")], ["Most requests first"]),
		}),
		table(h, { ariaLabel: "Top sources" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Client address"]),
					tableHead(h, ["Tool"]),
					tableHead(h, ["User agent"]),
					tableHead(h, ["Requests"], "text-right"),
					tableHead(h, ["Probes"], "text-right"),
					tableHead(h, ["Last seen"]),
				]),
			]),
			tableBody(
				h,
				sources.map((source) =>
					tableRow(
						h,
						[
							tableCell(h, [source.clientAddress], "font-mono text-xs"),
							tableCell(
								h,
								[source.scanner === "" ? "Unnamed" : source.scanner],
								source.scanner === "" ? "text-muted-foreground" : undefined,
							),
							tableCell(h, [
								h.span(
									[
										h.Class("block max-w-72 truncate text-xs text-muted-foreground"),
										h.Title(source.userAgent),
									],
									[source.userAgent === "" ? "None sent" : source.userAgent],
								),
							]),
							tableCell(h, [count(source.requests)], "text-right font-mono tabular-nums"),
							tableCell(h, [String(source.signatures)], "text-right font-mono tabular-nums"),
							tableCell(h, [lastSeen(h, clock, source.lastSeen)]),
						],
						undefined,
						[h.Key(source.clientAddress)],
					),
				),
			),
		]),
	])

// STATES

const exposureEmpty = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GlobeIcon")]),
				emptyTitle(h, ["No scanner traffic in the last 7 days"]),
				emptyDescription(h, [
					"Maple watches your HTTP server spans for scanner probes, requests for paths like /.env, /.git/config or /actuator/env, and for scanning tools that name themselves. Collection started when this view shipped, so there is no history from before.",
				]),
			]),
		],
		"rounded-md border md:py-16",
	)

export const telemetryLoading = (h: H): ReadonlyArray<Html> => [
	h.div(
		[h.AriaBusy(true), h.AriaLabel("Loading"), h.Class("grid grid-cols-2 gap-px xl:grid-cols-4")],
		Array.from({ length: 4 }, () => placeholder(h, "h-24")),
	),
	placeholder(h, "h-64 w-full"),
]

export const exposureBody = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> =>
	AsyncData.matchData(model.exposure.data, {
		onEmpty: () => telemetryLoading(h),
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: "Couldn't load scanner traffic",
				onRetry: Message.ClickedRetry(),
			}),
		],
		onData: (exposure) => {
			if (isExposureEmpty(exposure)) return [exposureEmpty(h)]
			const clock = { nowMs: model.nowMs, timeZone }
			const categories = categoryRows(exposure)
			const exposed = exposedRows(exposure)
			const catchAll = catchAllServices(exposure)
			return [
				...(exposed.length === 0 ? [] : [exposedPanel(h, clock, exposed, isExposedCapped(exposure))]),
				...(catchAll.length === 0 ? [] : [catchAllPanel(h, catchAll)]),
				totalsRail(h, clock, exposure),
				...(categories.length === 0 ? [] : [categoriesPanel(h, categories)]),
				...(exposure.sources.length === 0 ? [] : [sourcesPanel(h, clock, exposure.sources)]),
			]
		},
	})
