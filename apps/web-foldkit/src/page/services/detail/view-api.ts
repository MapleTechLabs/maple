import {
	type EndpointGroup,
	type EndpointSort,
	groupEndpoints,
	leafLabel,
} from "../../../components/services/endpoint-grouping"
import { errorRateClass, errorRateLevel } from "@maple/ui/lib/error-rate"
import { countLabel, formatErrorRate, formatLatency, formatNumber, formatRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { tableCell, tableRow } from "../../../ui/table"
import { truncatedText } from "../../../ui/truncated-text"
import { errorRateValue, latencyValue } from "../../../ui/values"
import { callsPerSecond } from "./derive"
import { Message } from "./message"
import type { Endpoint } from "./model-tabs"
import { barCell } from "./view-table-cells"

// The API tab: rows and group rows.

type H = HtmlBuilder<Message>

export type Maxima = Readonly<{ calls: number; p95: number }>

export const COLUMN = {
	rate: "w-[96px]",
	err: "w-[84px]",
	p50: "w-[84px]",
	p95: "w-[96px]",
	p99: "w-[84px]",
} as const

/** `methodTone`: only the mutating verbs are tinted. */
const methodTone = (method: string): string =>
	method === "POST" || method === "PUT" || method === "PATCH"
		? "text-severity-warn"
		: method === "DELETE"
			? "text-severity-error"
			: "text-muted-foreground"

const methodLabel = (h: H, method: string): Html =>
	h.span(
		[
			h.Class(
				cn(
					"w-[52px] shrink-0 font-mono text-2xs font-semibold uppercase tracking-wide",
					methodTone(method),
				),
			),
		],
		[method],
	)

const COLLAPSED_COPY = {
	unrouted: {
		label: "Unrouted paths",
		explainer: "URL paths rather than route templates — each distinct id counts as its own endpoint.",
	},
	probes: {
		label: "Scanner probes",
		explainer:
			"Paths no route matched, in the shape bots scan for. Kept out of the endpoint list, not deleted.",
	},
} as const

/** `GroupHeaderRow`: the group's totals in the row columns; p95/p99 are the worst in the group. */
const groupHeaderRow = (
	h: H,
	title: string,
	count: string,
	group: EndpointGroup,
	seconds: number,
	muted: boolean,
) => {
	const numeric = "py-1.5 text-right align-middle font-mono text-2xs tabular-nums text-muted-foreground/70"
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex min-w-0 items-baseline gap-2")],
						[
							h.span(
								[
									h.Class(
										cn(
											"truncate font-mono text-xs font-medium",
											muted ? "text-muted-foreground" : "text-foreground",
										),
									),
									h.Title(title),
								],
								[title],
							),
							h.span([h.Class("shrink-0 text-2xs text-muted-foreground/60")], [count]),
						],
					),
				],
				"max-w-0 py-1.5 pl-3 align-middle",
			),
			tableCell(
				h,
				[formatRate(callsPerSecond(group.totals.estimatedSpanCount, seconds))],
				cn(numeric, "pr-1.5"),
			),
			tableCell(
				h,
				[formatErrorRate(group.totals.errorRate)],
				cn(
					numeric,
					"pr-1.5",
					errorRateLevel(group.totals.errorRate) !== "neutral" &&
						errorRateClass(group.totals.errorRate),
				),
			),
			tableCell(h, [], numeric),
			tableCell(h, [formatLatency(group.totals.p95DurationMs)], cn(numeric, "pr-1.5"), [
				h.Title("Worst p95 in the group"),
			]),
			tableCell(h, [formatLatency(group.totals.p99DurationMs)], cn(numeric, "pr-3"), [
				h.Title("Worst p99 in the group"),
			]),
		],
		"border-b bg-muted/30 hover:bg-muted/30",
	)
}

const endpointRow = (h: H, endpoint: Endpoint, stem: string, seconds: number, maxima: Maxima): Html => {
	const { head, tail } = leafLabel(endpoint.route, stem)
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2.5")],
						[
							methodLabel(h, endpoint.method),
							truncatedText(h, { text: endpoint.route, mono: true, className: "text-xs" }, [
								...(head.length > 0
									? [h.span([h.Class("text-muted-foreground/50")], [head])]
									: []),
								h.span([h.Class("text-foreground")], [tail]),
							]),
						],
					),
				],
				cn("max-w-0 py-2 align-middle", stem.length > 0 ? "pl-6" : "pl-3"),
			),
			barCell(
				h,
				{ value: endpoint.estimatedSpanCount, max: maxima.calls, tone: "calls" },
				h.span(
					[h.Class("font-mono text-xs tabular-nums text-foreground")],
					[
						...(endpoint.estimatedSpanCount > endpoint.spanCount ? ["~"] : []),
						formatRate(callsPerSecond(endpoint.estimatedSpanCount, seconds)),
					],
				),
			),
			barCell(
				h,
				{ value: endpoint.errorRate > 0 ? endpoint.errorRate : 0, max: 0.05, tone: "errors" },
				errorRateValue(h, { rate: endpoint.errorRate, className: "text-xs" }),
			),
			tableCell(
				h,
				[latencyValue(h, { ms: endpoint.p50DurationMs, scale: "p50", className: "text-xs" })],
				"py-2 text-right align-middle",
			),
			barCell(
				h,
				{ value: endpoint.p95DurationMs, max: maxima.p95, tone: "latency" },
				latencyValue(h, { ms: endpoint.p95DurationMs, scale: "p95", className: "text-xs" }),
			),
			tableCell(
				h,
				[latencyValue(h, { ms: endpoint.p99DurationMs, scale: "p99", className: "text-xs" })],
				"py-2 pr-3 text-right align-middle",
			),
		],
		"group/row cursor-pointer border-b last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
		[
			h.Key(endpoint.spanName),
			h.Attribute("tabindex", "0"),
			h.OnClick(Message.ClickedOperation({ spanName: endpoint.spanName })),
		],
	)
}

/** `GroupRows`: a collapsed bucket with its explainer, or a stem header and its rows. */
export const groupRows = (
	h: H,
	group: EndpointGroup,
	seconds: number,
	maxima: Maxima,
	isExpanded: boolean,
): ReadonlyArray<Html> => {
	if (group.kind === "unrouted" || group.kind === "probes") {
		const copy = COLLAPSED_COPY[group.kind]
		const sample = group.endpoints.slice(0, 2).map((endpoint) => endpoint.route)
		const remaining = group.endpoints.length - sample.length
		return [
			groupHeaderRow(h, copy.label, countLabel(group.endpoints.length, "path"), group, seconds, true),
			tableRow(
				h,
				[
					tableCell(
						h,
						[
							h.div(
								[h.Class("flex items-center gap-4")],
								[
									h.div(
										[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
										[
											h.span(
												[h.Class("text-xs text-muted-foreground")],
												[copy.explainer],
											),
											h.span(
												[
													h.Class(
														"truncate font-mono text-2xs text-muted-foreground/50",
													),
												],
												[
													sample.join("  ·  "),
													remaining > 0
														? `  ·  ${formatNumber(remaining)} more`
														: "",
												],
											),
										],
									),
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											className: "shrink-0",
											attributes: [
												h.OnClick(
													Message.ClickedToggleEndpointGroup({ kind: group.kind }),
												),
											],
										},
										[isExpanded ? "Hide" : "Show anyway"],
									),
								],
							),
						],
						"py-2.5 pl-3 pr-3",
						[h.Attribute("colspan", "6")],
					),
				],
				"border-b hover:bg-transparent",
			),
			...(isExpanded
				? group.endpoints.map((endpoint) => endpointRow(h, endpoint, "", seconds, maxima))
				: []),
		]
	}
	return [
		...(group.kind === "stem"
			? [
					groupHeaderRow(
						h,
						group.stem,
						countLabel(group.endpoints.length, "endpoint"),
						group,
						seconds,
						false,
					),
				]
			: []),
		...group.endpoints.map((endpoint) => endpointRow(h, endpoint, group.stem, seconds, maxima)),
	]
}

export const groupsOf = (
	endpoints: ReadonlyArray<Endpoint>,
	sort: { key: string | null; dir: "asc" | "desc" },
) => groupEndpoints(endpoints, endpointSortOf(sort.key), sort.dir)

const ENDPOINT_SORTS: ReadonlyArray<EndpointSort> = ["traffic", "path", "errorRate", "p50", "p95", "p99"]
const endpointSortOf = (key: string | null): EndpointSort =>
	ENDPOINT_SORTS.find((sort) => sort === key) ?? "traffic"
