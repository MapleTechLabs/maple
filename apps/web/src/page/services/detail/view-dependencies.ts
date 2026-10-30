import { formatErrorRate, formatLatency, formatRate, formatThroughput } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon, type IconName } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHeader, tableRow } from "../../../ui/table"
import { errorRateValue, latencyValue, serviceDot } from "../../../ui/values"
import {
	type DependencyRow,
	dependencyRows,
	type DependencySummary,
	dependencySummary,
	foldHostRows,
} from "./derive-dependencies"
import type { DependencyKind } from "./derive-panels"
import { sortRows } from "../../kit/table-sort"
import { TRACE_DETAIL_LIMIT_SECONDS } from "./derive-tables"
import { Message } from "./message"
import type { Model } from "./model"
import { barCell, headLabel, sortColumnHead } from "./view-table-cells"

// `ServiceDependenciesTab` + `DependencyTable` + `DependencyTypeBadge` (components/services/).
// TODO(mobile-list): the `md:hidden` tap-to-trace list and its sort pills are not ported.
// TODO(sampled-tooltip): an estimated rate's "Estimated ×N" tooltip is not ported (trigger only).

type H = HtmlBuilder<Message>

const BADGE = new Map<DependencyKind, Readonly<{ label: string; tone: string; icon: IconName }>>([
	["service", { label: "Service", tone: "bg-severity-info/10 text-severity-info", icon: "ServerIcon" }],
	["database", { label: "Database", tone: "bg-chart-3/10 text-chart-3", icon: "DatabaseIcon" }],
	["http", { label: "HTTP", tone: "bg-foreground/5 text-muted-foreground", icon: "GlobeIcon" }],
	["messaging", { label: "Queue", tone: "bg-chart-4/10 text-chart-4", icon: "PaperPlaneIcon" }],
	["rpc", { label: "RPC", tone: "bg-chart-5/10 text-chart-5", icon: "NetworkNodesIcon" }],
])

const typeBadge = (h: H, kind: DependencyKind): Html => {
	const entry = BADGE.get(kind) ?? { label: kind, tone: "", icon: "GlobeIcon" }
	return badge(h, { variant: "secondary", size: "sm", className: cn("uppercase", entry.tone) }, [
		icon(h, entry.icon, { size: 10 }),
		entry.label,
	])
}

/** `SampledValue`: "~" when estimated; an estimate carries its tooltip trigger. */
const sampledRate = (h: H, row: DependencyRow): Html =>
	h.span(
		[h.Class(cn(row.hasSampling && "cursor-help", "tabular-nums font-mono text-xs text-foreground"))],
		[...(row.hasSampling ? ["~"] : []), formatRate(row.callsPerSec)],
	)

const dependencyRow = (h: H, row: DependencyRow, maxima: Readonly<{ calls: number; p95: number }>): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex items-center gap-2.5 min-w-0")],
						[
							typeBadge(h, row.kind),
							h.div(
								[h.Class("flex min-w-0 flex-col leading-tight")],
								[
									h.span(
										[
											h.Class(
												"flex min-w-0 items-center gap-1.5 text-xs text-foreground",
											),
										],
										[
											...(row.kind === "service"
												? [serviceDot(h, { serviceName: row.name, size: "sm" })]
												: []),
											h.span([h.Class("truncate"), h.Title(row.name)], [row.name]),
										],
									),
									...(row.subtitle === undefined
										? []
										: [
												h.span(
													[h.Class("truncate text-3xs text-muted-foreground/60")],
													[row.subtitle],
												),
											]),
								],
							),
						],
					),
				],
				"max-w-0 py-2 pl-3 align-middle",
			),
			barCell(h, { value: row.callsPerSec, max: maxima.calls, tone: "calls" }, sampledRate(h, row)),
			barCell(
				h,
				{ value: row.errorRate > 0 ? row.errorRate : 0, max: 0.05, tone: "errors" },
				errorRateValue(h, { rate: row.errorRate, className: "text-xs" }),
			),
			tableCell(
				h,
				[latencyValue(h, { ms: row.avgDurationMs, scale: "avg", className: "text-xs" })],
				"py-2 text-right align-middle",
			),
			barCell(
				h,
				{ value: row.p95DurationMs, max: maxima.p95, tone: "latency" },
				latencyValue(h, { ms: row.p95DurationMs, scale: "p95", className: "text-xs" }),
			),
		],
		"cursor-pointer group/row border-b last:border-b-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
		[
			h.Key(row.id),
			h.Attribute("tabindex", "0"),
			h.OnClick(Message.ClickedDependency({ whereClause: row.whereClause })),
		],
	)

const dependencyTable = (h: H, model: Model, rows: ReadonlyArray<DependencyRow>): Html => {
	const sort = model.sorts.dependencies
	const maxima = rows.reduce(
		(acc, row) => ({
			calls: Math.max(acc.calls, row.callsPerSec),
			p95: Math.max(acc.p95, row.p95DurationMs),
		}),
		{ calls: 0, p95: 0 },
	)
	const sorted = sortRows(rows, sort, (row, key) =>
		key === "errorRate" ? row.errorRate : key === "p95DurationMs" ? row.p95DurationMs : row.callsPerSec,
	)
	const column = (sortKey: string, label: string) =>
		sortColumnHead(h, { table: "dependencies", sortKey, label, sort })
	return panel(h, { className: "hidden md:block" }, [
		table(h, {}, [
			tableHeader(h, [
				tableRow(
					h,
					[
						headLabel(h, ["Target"], "pl-3"),
						column("callsPerSec", "Calls /s"),
						column("errorRate", "Errors"),
						headLabel(h, ["Avg"], "text-right"),
						column("p95DurationMs", "p95"),
					],
					"border-b",
				),
			]),
			tableBody(
				h,
				sorted.length === 0
					? [
							tableRow(h, [
								tableCell(
									h,
									[
										emptyMessage(h, {}, [
											"No downstream dependencies in this window.",
											h.span(
												[h.Class("mt-1 block text-muted-foreground/70")],
												[
													"Outgoing calls show up when client spans carry peer.service or server.address.",
												],
											),
										]),
									],
									"p-0",
									[h.Attribute("colspan", "5")],
								),
							]),
						]
					: sorted.map((row) => dependencyRow(h, row, maxima)),
			),
		]),
	])
}

const headlineFact = (
	h: H,
	label: string,
	name: string,
	value: Html | string,
	valueClassName?: string,
): Html =>
	h.span(
		[
			h.Class(
				"flex w-full items-baseline justify-between gap-1.5 sm:inline-flex sm:w-auto sm:justify-start",
			),
		],
		[
			h.span(
				[h.Class("flex min-w-0 items-baseline gap-1.5")],
				[
					eyebrow(h, {}, [label]),
					h.span([h.Class("max-w-[60vw] truncate text-foreground sm:max-w-[140px]")], [name]),
				],
			),
			h.span(
				[h.Class(cn("shrink-0 tabular-nums font-mono", valueClassName ?? "text-foreground"))],
				[value],
			),
		],
	)

const summaryStrip = (h: H, count: number, summary: DependencySummary): Html =>
	h.div(
		[
			h.Class(
				"flex flex-col gap-2 text-2xs text-muted-foreground sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-5 sm:gap-y-1",
			),
		],
		[
			h.div(
				[h.Class("flex items-baseline gap-x-3")],
				[
					h.span(
						[h.Class("text-foreground")],
						[
							h.span([h.Class("tabular-nums font-mono font-medium")], [String(count)]),
							" ",
							h.span([h.Class("text-muted-foreground")], ["downstream"]),
						],
					),
					h.span([h.Class("text-muted-foreground/60")], [summary.breakdown]),
				],
			),
			h.span([h.Class("hidden grow sm:block")]),
			h.div(
				[h.Class("flex flex-col gap-1 sm:contents")],
				[
					headlineFact(
						h,
						"Busiest",
						summary.topByCalls.name,
						`${summary.topByCalls.hasSampling ? "~" : ""}${formatThroughput(summary.topByCalls.callsPerSec, "/s")}`,
					),
					summary.topByErrors === undefined
						? headlineFact(h, "Errors", "none", "0%")
						: headlineFact(
								h,
								"Most errors",
								summary.topByErrors.name,
								formatErrorRate(summary.topByErrors.errorRate),
								cn(TONE_TEXT.crit),
							),
					headlineFact(
						h,
						"Slowest p95",
						summary.topByLatency.name,
						formatLatency(summary.topByLatency.p95DurationMs),
						cn("text-foreground", latencyToneClass(summary.topByLatency.p95DurationMs, "p95")),
					),
				],
			),
		],
	)

/** The Dependencies tab: summary strip, the 30-day note, and the sortable table. */
export const dependenciesTab = (h: H, model: Model): Html => {
	const window = model.window
	const startMs = window === null ? 0 : parseWarehouseDateTime(window.startTime)
	const endMs = window === null ? 0 : parseWarehouseDateTime(window.endTime)
	const seconds = startMs > 0 && endMs > 0 ? Math.max((endMs - startMs) / 1000, 1) : 3600
	const rows = foldHostRows(
		AsyncData.getOrElse(
			AsyncData.map(model.dependencies.data, (bundle) => dependencyRows(bundle, seconds)),
			() => [],
		),
	)
	const summary = dependencySummary(rows)
	const isWaiting = AsyncData.isRefreshing(model.dependencies.data)
	return h.div(
		[
			h.Class(cn("flex flex-col gap-3", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			...(summary === undefined ? [] : [summaryStrip(h, rows.length, summary)]),
			...(seconds > TRACE_DETAIL_LIMIT_SECONDS
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Dependency summaries cover the selected range; individual trace drill-downs show the latest 30 days.",
							],
						),
					]
				: []),
			dependencyTable(h, model, rows),
		],
	)
}
