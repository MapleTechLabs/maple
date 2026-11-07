import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
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
import { statusDot } from "@maple/views/ui/status-dot"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { NARROW_TWO_COLUMNS, WIDE_COLUMN } from "../kit/layout"
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
import { dividedList } from "@maple/views/ui/rule"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The Exposure tab: probe paths a service answered, the week's totals, categories and sources.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const lastSeen = (h: H, clock: Clock, value: string): Html =>
	relativeTime(h, {
		value,
		nowMs: clock.nowMs,
		timeZone: clock.timeZone,
		variant: "orDate",
		className: typographyClass({ size: "xs", tone: "muted", className: "whitespace-nowrap" }),
	})

const count = (value: number): string => formatNumber(value)

// EXPOSED PROBES

const EXPOSED_COPY =
	"A scanner asked for something that should never be public and the service answered with a 2xx. Check that the response does not contain it. Services that answer almost every path are listed separately as likely catch-all routes."

const sampleTraceLink = (h: H, traceId: string): Html =>
	textLink(
		h,
		{
			tone: "muted",
			className: "whitespace-nowrap text-xs",
			href: hrefOf(AppRoute.Trace({ traceId, search: {} })),
		},
		["Sample trace"],
	)

const exposedPanel = (h: H, clock: Clock, rows: Exposure["exposed"], capped: boolean): Html =>
	panel(h, { className: "overflow-hidden border-severity-error-a3" }, [
		panelHeader(h, {
			className: "bg-severity-error-a1",
			title: hstack(h, { gap: "2", as: "span" }, [
				icon(h, "CircleWarningIcon", { size: 16, className: "shrink-0 text-severity-error" }),
				`${rows.length}${capped ? "+" : ""} probe ${rows.length === 1 && !capped ? "path" : "paths"} answered with a success`,
			]),
		}),
		h.p([h.Class("max-w-3xl px-4 pt-3 pb-1 font-prose text-sm text-muted-foreground")], [EXPOSED_COPY]),
		table(h, { ariaLabel: "Probe paths answered with a success" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Service"]),
					tableHead(h, ["Path"], WIDE_COLUMN),
					tableHead(h, ["Category"], WIDE_COLUMN),
					tableHead(h, ["Status"]),
					tableHead(h, ["Requests"], cn("text-right", WIDE_COLUMN)),
					tableHead(h, ["Last seen"], WIDE_COLUMN),
					tableHead(h, [h.span([h.Class("sr-only")], ["Trace"])], WIDE_COLUMN),
				]),
			]),
			tableBody(
				h,
				Arr.map(rows, (row) =>
					tableRow(
						h,
						[
							tableCell(
								h,
								[
									row.service,
									// Phones drop the path column, so the path rides under its service.
									h.span(
										[
											h.Class(
												"block max-w-60 truncate font-mono text-xs font-normal text-muted-foreground sm:hidden",
											),
										],
										[row.path],
									),
									...(row.sampleTraceId === ""
										? []
										: [
												h.span(
													[h.Class("block font-normal sm:hidden")],
													[sampleTraceLink(h, row.sampleTraceId)],
												),
											]),
								],
								"font-medium",
							),
							tableCell(
								h,
								[
									h.span(
										[
											h.Class("block max-w-80 truncate font-mono text-xs"),
											h.Title(`${row.host}${row.path}`),
										],
										[typography(h, { tone: "muted" }, [row.host]), row.path],
									),
								],
								WIDE_COLUMN,
							),
							tableCell(
								h,
								[categoryLabelOf(row.signature)],
								cn(typographyClass({ size: "xs", tone: "muted" }), WIDE_COLUMN),
							),
							tableCell(h, [
								badge(h, { variant: "crit", mono: true }, [String(row.httpStatus)]),
							]),
							tableCell(
								h,
								[count(row.requests)],
								cn(
									typographyClass({ mono: true, numeric: true, className: "text-right" }),
									WIDE_COLUMN,
								),
							),
							tableCell(h, [lastSeen(h, clock, row.lastSeen)], WIDE_COLUMN),
							tableCell(
								h,
								row.sampleTraceId === "" ? [] : [sampleTraceLink(h, row.sampleTraceId)],
								cn("text-right", WIDE_COLUMN),
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
	const floor = totals.isSignaturesCapped ? "+" : ""
	const exposedCount = exposedRows(exposure).length
	const catchAllCount = catchAllServices(exposure).length
	const plus = isExposedCapped(exposure) ? "+" : ""
	return statRail(h, { columns: 4, className: NARROW_TWO_COLUMNS }, [
		statRailItem(h, {
			eyebrow: "Probe requests",
			value: `${count(totals.probeRequests)}${floor}`,
			spark: timelineValues(exposure, clock.nowMs, TIMELINE_BUCKET_SECONDS, 28),
			subline: "paths only scanners ask for",
		}),
		statRailItem(h, {
			eyebrow: "Scanner requests",
			value: `${count(totals.scannerRequests)}${floor}`,
			compact: true,
			subline: "named tools on ordinary paths",
		}),
		statRailItem(h, {
			eyebrow: "Clients",
			value: totals.isSourcesCapped ? `${SOURCES_SHOWN}+` : String(totals.sources),
			compact: true,
			subline: totals.isSourcesCapped
				? `client addresses, the ${SOURCES_SHOWN} most active listed`
				: "distinct client addresses",
		}),
		statRailItem(h, {
			eyebrow: "Services probed",
			value: `${totals.servicesProbed}${floor}`,
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
				Arr.some(services, (entry) => entry.sampleTraceId !== "")
					? `${CATCH_ALL_COPY} Open a sample trace to confirm nothing real is served.`
					: `${CATCH_ALL_COPY} Check one response to confirm nothing real is served.`,
			],
		),
		dividedList(
			h,
			{ as: "ul", bordered: false, className: "px-4 pb-2 text-sm" },
			Arr.map(services, (entry) =>
				hstack(h, { gap: "4", align: "center", justify: "between", as: "li", className: "py-2" }, [
					typography(h, { weight: "medium" }, [entry.service]),
					hstack(h, { gap: "4", as: "span" }, [
						typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
							`${entry.answered} of ${entry.probed} sensitive probe paths answered`,
						]),
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
					]),
				]),
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
			action: typography(h, { size: "xs", tone: "muted" }, [
				"Answered counts 2xx responses, catch-all routes left out",
			]),
		}),
		table(h, { ariaLabel: "Probe categories" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Category"]),
					tableHead(h, ["Requests"], "text-right"),
					tableHead(h, ["Answered"], "text-right"),
					tableHead(h, ["Services"], cn("text-right", WIDE_COLUMN)),
					tableHead(h, ["Top signatures"], WIDE_COLUMN),
				]),
			]),
			tableBody(
				h,
				Arr.map(rows, (row) =>
					tableRow(
						h,
						[
							tableCell(h, [row.label], "font-medium max-sm:whitespace-normal"),
							tableCell(
								h,
								[count(row.requests)],
								typographyClass({ mono: true, numeric: true, className: "text-right" }),
							),
							tableCell(h, [answeredCell(h, row)], "text-right"),
							tableCell(
								h,
								[String(row.services)],
								cn(
									typographyClass({ mono: true, numeric: true, className: "text-right" }),
									WIDE_COLUMN,
								),
							),
							tableCell(
								h,
								[
									hstack(
										h,
										{ gap: "1.5", wrap: true, as: "span" },
										Arr.map(row.topSignatures, (signature) =>
											h.span(
												[
													h.Key(signature.signature),
													h.Title(`${count(signature.requests)} requests`),
												],
												[inlineCode(h, {}, [signature.signature])],
											),
										),
									),
								],
								WIDE_COLUMN,
							),
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
			title: "Top clients",
			action: typography(h, { size: "xs", tone: "muted" }, ["Most requests first"]),
		}),
		table(h, { ariaLabel: "Top clients" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Client address"]),
					tableHead(h, ["Tool"]),
					tableHead(h, ["User agent"], WIDE_COLUMN),
					tableHead(h, ["Requests"], "text-right"),
					tableHead(h, ["Distinct probes"], cn("text-right", WIDE_COLUMN)),
					tableHead(h, ["Last seen"], WIDE_COLUMN),
				]),
			]),
			tableBody(
				h,
				Arr.map(sources, (source) =>
					tableRow(
						h,
						[
							tableCell(h, [source.clientAddress], typographyClass({ size: "xs", mono: true })),
							tableCell(
								h,
								[source.scanner === "" ? "Unnamed" : source.scanner],
								source.scanner === "" ? "text-muted-foreground" : undefined,
							),
							tableCell(
								h,
								[
									h.span(
										[
											h.Class("block max-w-72 truncate text-xs text-muted-foreground"),
											h.Title(source.userAgent),
										],
										[source.userAgent === "" ? "None sent" : source.userAgent],
									),
								],
								WIDE_COLUMN,
							),
							tableCell(
								h,
								[count(source.requests)],
								typographyClass({ mono: true, numeric: true, className: "text-right" }),
							),
							tableCell(
								h,
								[String(source.signatures)],
								cn(
									typographyClass({ mono: true, numeric: true, className: "text-right" }),
									WIDE_COLUMN,
								),
							),
							tableCell(h, [lastSeen(h, clock, source.lastSeen)], WIDE_COLUMN),
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
		emptyFrameClass("dashed"),
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
				totalsRail(h, clock, exposure),
				...(exposed.length === 0 ? [] : [exposedPanel(h, clock, exposed, isExposedCapped(exposure))]),
				...(catchAll.length === 0 ? [] : [catchAllPanel(h, catchAll)]),
				...(categories.length === 0 ? [] : [categoriesPanel(h, categories)]),
				...(exposure.sources.length === 0 ? [] : [sourcesPanel(h, clock, exposure.sources)]),
			]
		},
	})
