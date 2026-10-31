import { formatRate } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { skeletonListGapStyles, skeletonListStyles } from "@maple/ui/styles/ui/skeleton"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import * as Sparkline from "../../../charts/sparkline"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHeader, tableRow } from "../../../ui/table"
import { errorRateValue, latencyValue } from "../../../ui/values"
import { callsPerSecond, windowSeconds } from "./derive"
import { sortRows } from "../../kit/table-sort"
import { TRACE_DETAIL_LIMIT_SECONDS } from "./derive-tables"
import { Message } from "./message"
import type { Model } from "./model"
import type { Operation } from "./model-tabs"
import { SPARKLINE_TOKEN } from "./view-panels"
import { barCell, headLabel, sortColumnHead } from "./view-table-cells"

// The Operations tab, desktop table.
// TODO(mobile-list): the `md:hidden` tap-to-trace list and its sort pills are not ported.
// TODO(row-keyboard): Enter / Space on a focused row does not drill down yet; click does.

type H = HtmlBuilder<Message>

const SPARKLINE_MODEL = Chart.init()
const toSparkline = (message: Chart.Message) => Message.GotChartMessage({ chartId: "sparkline", message })

const loadingState = (h: H): Html =>
	panel(h, {}, [
		h.div(
			[
				h.AriaBusy(true),
				h.Class(cn(skeletonListStyles, skeletonListGapStyles.px, "gap-0")),
				h.DataAttribute("slot", "skeleton-list"),
			],
			Array.from({ length: 10 }, () =>
				h.div(
					[h.Class("flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0")],
					[
						skeleton(h, "h-3 flex-1"),
						skeleton(h, "h-3 w-12"),
						skeleton(h, "h-3 w-10"),
						skeleton(h, "h-3 w-12"),
						skeleton(h, "hidden h-5 w-32 md:block"),
					],
				),
			),
		),
	])

const operationRow = (
	h: H,
	op: Operation,
	context: Readonly<{ seconds: number; maxCalls: number; maxP95: number; color: string }>,
): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.span(
						[h.Class("block truncate font-mono text-xs text-foreground"), h.Title(op.spanName)],
						[op.spanName],
					),
				],
				"max-w-0 py-2 pl-3 align-middle",
			),
			barCell(
				h,
				{ value: op.estimatedSpanCount, max: context.maxCalls, tone: "calls" },
				h.span(
					[h.Class("tabular-nums font-mono text-xs text-foreground")],
					[
						...(op.estimatedSpanCount > op.spanCount ? ["~"] : []),
						formatRate(callsPerSecond(op.estimatedSpanCount, context.seconds)),
					],
				),
			),
			barCell(
				h,
				{ value: op.errorRate > 0 ? op.errorRate : 0, max: 0.05, tone: "errors" },
				errorRateValue(h, { rate: op.errorRate, className: "text-xs" }),
			),
			tableCell(
				h,
				[latencyValue(h, { ms: op.p50DurationMs, scale: "p50", className: "text-xs" })],
				"py-2 text-right align-middle",
			),
			barCell(
				h,
				{ value: op.p95DurationMs, max: context.maxP95, tone: "latency" },
				latencyValue(h, { ms: op.p95DurationMs, scale: "p95", className: "text-xs" }),
			),
			tableCell(
				h,
				[
					h.submodel({
						slotId: `ops-spark-${op.spanName}`,
						model: SPARKLINE_MODEL,
						view: Sparkline.view,
						viewInputs: {
							chartId: `ops-${op.spanName}`,
							values: op.sparkline.map((point) => point.count),
							color: context.color,
							className: "ml-auto h-6 w-32",
							revision: 0,
							fillOpacity: [0.5, 0.1],
						},
						toParentMessage: toSparkline,
					}),
				],
				"py-1.5 pr-3 align-middle",
			),
		],
		"cursor-pointer group/row border-b last:border-b-0 hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
		[
			h.Key(op.spanName),
			h.Attribute("tabindex", "0"),
			h.OnClick(Message.ClickedOperation({ spanName: op.spanName })),
		],
	)

const operationsTable = (
	h: H,
	model: Model,
	operations: ReadonlyArray<Operation>,
	theme: ThemeColors | null,
) => {
	const sort = model.sorts.operations
	const seconds = model.window === null ? 0 : windowSeconds(model.window)
	const context = {
		seconds,
		maxCalls: operations.reduce((acc, op) => Math.max(acc, op.estimatedSpanCount), 0),
		maxP95: operations.reduce((acc, op) => Math.max(acc, op.p95DurationMs), 0),
		color: resolveColor(theme ?? {}, SPARKLINE_TOKEN),
	}
	const sorted = sortRows(operations, sort, (op, key) =>
		key === "errorRate"
			? op.errorRate
			: key === "p50DurationMs"
				? op.p50DurationMs
				: key === "p95DurationMs"
					? op.p95DurationMs
					: op.estimatedSpanCount,
	)
	const column = (sortKey: string, label: string) =>
		sortColumnHead(h, { table: "operations", sortKey, label, sort })
	return panel(h, { className: "hidden md:block" }, [
		table(h, {}, [
			tableHeader(h, [
				tableRow(
					h,
					[
						headLabel(h, ["Operation"], "pl-3"),
						column("estimatedSpanCount", "Calls /s"),
						column("errorRate", "Errors"),
						column("p50DurationMs", "p50"),
						column("p95DurationMs", "p95"),
						headLabel(h, ["Activity"], "w-36 pr-3 text-right"),
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
									[emptyMessage(h, {}, ["No operations recorded in this window."])],
									"p-0",
									[h.Attribute("colspan", "6")],
								),
							]),
						]
					: sorted.map((op) => operationRow(h, op, context)),
			),
		]),
	])
}

/** The Operations tab: skeleton, error, or the sortable table (window note past 30 days). */
export const operationsTab = (h: H, model: Model, theme: ThemeColors | null): Html =>
	AsyncData.match(model.operations.data, {
		onIdle: () => loadingState(h),
		onLoading: () => loadingState(h),
		onFailure: (failure) => errorState(h, { failure, title: "Couldn't load operations" }),
		onStale: ({ error }) => errorState(h, { failure: error, title: "Couldn't load operations" }),
		onRefreshing: (operations) => operationsBody(h, model, operations, theme, true),
		onSuccess: (operations) => operationsBody(h, model, operations, theme, false),
	})

const operationsBody = (
	h: H,
	model: Model,
	operations: ReadonlyArray<Operation>,
	theme: ThemeColors | null,
	isWaiting: boolean,
): Html => {
	const isLimited = model.window !== null && windowSeconds(model.window) > TRACE_DETAIL_LIMIT_SECONDS
	return h.div(
		[
			h.Class(cn("flex flex-col gap-2", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			...(isLimited
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Operation summaries cover the selected range; individual trace drill-downs show the latest 30 days.",
							],
						),
					]
				: []),
			operationsTable(h, model, operations, theme),
		],
	)
}
