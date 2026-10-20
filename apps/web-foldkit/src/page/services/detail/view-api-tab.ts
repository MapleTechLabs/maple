import { ENDPOINTS_LIMIT, isTruncated } from "../../../components/services/service-endpoints"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatLatency, formatNumber, formatRate } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { skeletonListGapStyles, skeletonListStyles, skeletonStyles } from "@maple/ui/styles/ui/skeleton"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableHeader, tableRow } from "../../../ui/table"
import { docsLink } from "../../kit/signal-empty-state"
import { callsPerSecond, windowSeconds } from "./derive"
import { TRACE_DETAIL_LIMIT_SECONDS } from "./derive-tables"
import type { Message } from "./message"
import type { Model } from "./model"
import type { Endpoint } from "./model-tabs"
import { COLUMN, groupRows, groupsOf } from "./view-api"
import { sortColumnHead } from "./view-table-cells"

// `ServiceApiTab`: the summary line, the grouped sortable table, its loading and empty states.
// TODO(mobile-list): the `md:hidden` tap-to-trace list and its sort pills are not ported.
// TODO(row-keyboard): Enter / Space on a focused row does not drill down yet; click does.

type H = HtmlBuilder<Message>

const stat = (h: H, label: string, value: string, className?: string): Html =>
	h.span(
		[h.Class("inline-flex items-baseline gap-1")],
		[
			h.span([h.Class(cn("font-mono font-medium tabular-nums text-foreground", className))], [value]),
			h.span([h.Class("text-muted-foreground")], [label]),
		],
	)

const columnWidths = [COLUMN.rate, COLUMN.err, COLUMN.p50, COLUMN.p95, COLUMN.p99]

const loadingState = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-2")],
		[
			h.div(
				[h.Class("flex items-center gap-4 px-0.5")],
				[64, 56, 48, 72].map((width) =>
					h.div([
						h.Class(cn(skeletonStyles, "h-3")),
						h.DataAttribute("slot", "skeleton"),
						h.Style({ width: `${width}px` }),
					]),
				),
			),
			panel(h, {}, [
				h.div(
					[h.Class("flex items-center gap-3 border-b px-3 py-2.5")],
					[
						skeleton(h, "h-2.5 flex-1"),
						...columnWidths.map((width) =>
							h.div(
								[h.Class(cn(width, "flex shrink-0 justify-end"))],
								[skeleton(h, "h-2.5 w-8")],
							),
						),
					],
				),
				h.div(
					[
						h.AriaBusy(true),
						h.Class(cn(skeletonListStyles, skeletonListGapStyles.px, "gap-0")),
						h.DataAttribute("slot", "skeleton-list"),
					],
					Array.from({ length: 10 }, (_, index) =>
						h.div(
							[
								h.Class(
									cn(
										"flex items-center gap-3 border-b py-2.5 pr-3 last:border-b-0",
										index % 4 === 0 ? "bg-muted/30 pl-3" : "pl-6",
									),
								),
							],
							[
								...(index % 4 !== 0 ? [skeleton(h, "h-2.5 w-9 shrink-0")] : []),
								skeleton(
									h,
									cn(
										"h-2.5",
										index % 3 === 0
											? "w-[220px]"
											: index % 3 === 1
												? "w-[150px]"
												: "w-[108px]",
									),
								),
								h.span([h.Class("flex-1")]),
								...columnWidths.map((width) =>
									h.div(
										[h.Class(cn(width, "flex shrink-0 justify-end"))],
										[skeleton(h, "h-2.5 w-10")],
									),
								),
							],
						),
					),
				),
			]),
		],
	)

/** `ApiEmptyState`: names the two conditions an endpoint needs. */
const emptyState = (h: H, serviceName: string): Html => {
	const mono = (text: string) => h.span([h.Class("font-mono text-foreground/80")], [text])
	return panel(h, { className: "items-center gap-3.5 px-[18px] py-11 text-center" }, [
		h.span(
			[h.Class("font-mono text-title font-medium text-foreground/90")],
			["No HTTP endpoints in this window"],
		),
		h.span(
			[h.Class("max-w-[620px] text-ui leading-[21px] text-muted-foreground")],
			[
				mono(serviceName),
				" reported spans in this range, but none are HTTP server spans with a route. An endpoint needs a server span carrying",
				" ",
				mono("http.route"),
				" or",
				" ",
				mono("url.path"),
				".",
			],
		),
		docsLink(h, "otelConventions"),
	])
}

const loaded = (h: H, model: Model, endpoints: ReadonlyArray<Endpoint>, isWaiting: boolean): Html => {
	if (endpoints.length === 0) return emptyState(h, model.serviceName)
	const sort = model.sorts.endpoints
	const seconds = model.window === null ? 0 : windowSeconds(model.window)
	const groups = groupsOf(endpoints, sort)
	const served = groups
		.filter((group) => group.kind === "stem" || group.kind === "ungrouped")
		.flatMap((group) => group.endpoints)
	const spanCount = served.reduce((sum, endpoint) => sum + endpoint.estimatedSpanCount, 0)
	const errorCount = served.reduce((sum, endpoint) => sum + endpoint.estimatedErrorCount, 0)
	const worstP99 = served.reduce((worst, endpoint) => Math.max(worst, endpoint.p99DurationMs), 0)
	const maxima = served.reduce(
		(acc, endpoint) => ({
			calls: Math.max(acc.calls, endpoint.estimatedSpanCount),
			p95: Math.max(acc.p95, endpoint.p95DurationMs),
		}),
		{ calls: 0, p95: 0 },
	)
	const errorRate = spanCount > 0 ? errorCount / spanCount : 0
	const notes = [
		...(isTruncated(endpoints.length)
			? [
					`Showing the ${ENDPOINTS_LIMIT} busiest endpoints — this service has more. Narrow the time range or environment to see the rest.`,
				]
			: []),
		...(seconds > TRACE_DETAIL_LIMIT_SECONDS
			? ["Endpoint summaries cover the selected range; trace drill-downs show the latest 30 days."]
			: []),
	]
	const column = (sortKey: string, label: string, className: string, align?: "left") =>
		sortColumnHead(h, { table: "endpoints", sortKey, label, sort, className, align })
	return h.div(
		[
			h.Class(cn("flex flex-col gap-2", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline gap-x-4 gap-y-1 px-0.5 text-xs")],
				[
					stat(h, "endpoints", formatNumber(served.length)),
					stat(h, "req/s", formatRate(callsPerSecond(spanCount, seconds))),
					stat(h, "errors", formatErrorRate(errorRate), errorRateClass(errorRate)),
					stat(h, "worst p99", formatLatency(worstP99)),
					...notes.map((note) => h.span([h.Key(note), h.Class("text-muted-foreground")], [note])),
				],
			),
			panel(h, { className: "hidden md:block" }, [
				table(h, {}, [
					tableHeader(h, [
						tableRow(
							h,
							[
								column("path", "Endpoint", "pl-3", "left"),
								column("traffic", "Req/s", COLUMN.rate),
								column("errorRate", "Errors", COLUMN.err),
								column("p50", "p50", COLUMN.p50),
								column("p95", "p95", COLUMN.p95),
								column("p99", "p99", cn(COLUMN.p99, "pr-3")),
							],
							"border-b",
						),
					]),
					tableBody(
						h,
						groups.flatMap((group) =>
							groupRows(
								h,
								group,
								seconds,
								maxima,
								model.expandedEndpointGroups.includes(group.kind),
							),
						),
					),
				]),
			]),
		],
	)
}

/** The API tab: skeleton, error, the empty explanation, or the grouped table. */
export const apiTab = (h: H, model: Model): Html =>
	AsyncData.match(model.endpoints.data, {
		onIdle: () => loadingState(h),
		onLoading: () => loadingState(h),
		onFailure: (failure) => errorState(h, { failure }),
		onStale: ({ error }) => errorState(h, { failure: error }),
		onRefreshing: (endpoints) => loaded(h, model, endpoints, true),
		onSuccess: (endpoints) => loaded(h, model, endpoints, false),
	})
