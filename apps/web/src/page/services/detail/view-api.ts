import {
	type EndpointGroup,
	type EndpointSort,
	groupEndpoints,
	leafLabel,
} from "../../../components/services/endpoint-grouping"
import {
	countLabel,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatRate,
} from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ThemeColors } from "../../../charts/theme-colors"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { tableCell, tableRow } from "../../../ui/table"
import { truncatedText } from "../../../ui/truncated-text"
import { latencyValue } from "../../../ui/values"
import { callsPerSecond } from "./derive"
import { knownStatusMix, serverShare, type StatusMix } from "./derive-api"
import { Message } from "./message"
import type { Endpoint } from "./model-tabs"
import { SPARK_TOKENS, sparkline } from "./view-api-charts"

// The API tab: endpoint rows and group rows.

type H = HtmlBuilder<Message>

/** Below `md` the table keeps the endpoint, its rate, 4xx share and p95; the rest hide. */
export const COLUMN = {
	rate: "w-14 md:w-[176px]",
	mix: "w-12 md:w-[176px]",
	err: "hidden w-[72px] md:table-cell",
	p50: "hidden w-[84px] md:table-cell",
	p95: "w-16 md:w-[84px]",
	p99: "hidden w-[84px] md:table-cell",
	body: "hidden w-[88px] md:table-cell",
	chevron: "w-6 md:w-10",
} as const

export const COLUMN_COUNT = 9

/** What every row reads besides its endpoint. */
export type RowContext = Readonly<{
	seconds: number
	/** Per span name, the request rate per bucket for the sparkline. */
	sparks: ReadonlyMap<string, ReadonlyArray<number>>
	theme: ThemeColors | null
	selected: string | undefined
	slowest: string | null
}>

/** `methodTone`: only the mutating verbs are tinted. */
const methodTone = (method: string): string =>
	method === "POST" || method === "PUT" || method === "PATCH"
		? "text-severity-warn"
		: method === "DELETE"
			? "text-severity-error"
			: "text-muted-foreground"

export const methodLabel = <M>(h: HtmlBuilder<M>, method: string, className = "w-10"): Html =>
	h.span([h.Class(cn("shrink-0 text-2xs font-medium uppercase", methodTone(method), className))], [method])

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

const numeric = "text-right align-middle tabular-nums"

/** The 2xx/4xx/5xx bar; an unknown mix (rows older than the counters) is an empty track. */
export const statusMixBar = <M>(h: HtmlBuilder<M>, mix: StatusMix | null, className = "w-24"): Html =>
	h.div(
		[
			h.Class(cn("flex h-1.5 shrink-0 overflow-hidden rounded-full bg-muted", className)),
			h.Title(
				mix === null
					? "No status codes recorded in this window"
					: `2xx ${formatErrorRate(mix.ok)} · 4xx ${formatErrorRate(mix.client)} · 5xx ${formatErrorRate(mix.server)}`,
			),
		],
		mix === null
			? []
			: [
					h.div([h.Class("h-full bg-chart-3"), h.Style({ width: `${mix.ok * 100}%` })]),
					h.div([h.Class("h-full bg-warning"), h.Style({ width: `${mix.client * 100}%` })]),
					h.div([h.Class("h-full bg-severity-error"), h.Style({ width: `${mix.server * 100}%` })]),
				],
	)

/** A share as the table prints it: zero is muted, anything else toned. */
const shareText = (h: H, share: number | null, tone: string): Html =>
	h.span(
		[h.Class(share === null || share === 0 ? "text-muted-foreground" : tone)],
		[share === null ? "—" : formatErrorRate(share)],
	)

const rateText = (endpoint: Endpoint, seconds: number) =>
	`${endpoint.estimatedSpanCount > endpoint.spanCount ? "~" : ""}${formatRate(callsPerSecond(endpoint.estimatedSpanCount, seconds))}`

/** The slowest endpoint's p50/p95 sit in a chip so the eye lands on them. */
const latencyCell = (h: H, ms: number, scale: "p50" | "p95" | "p99", isChip: boolean, width: string) =>
	tableCell(
		h,
		[
			latencyValue(h, {
				ms,
				scale,
				className: cn(
					"text-ui",
					isChip && "rounded-sm bg-muted px-1.5 py-0.5 text-warning-foreground",
				),
			}),
		],
		cn(numeric, "py-0 pr-0", width),
	)

const endpointRow = (h: H, endpoint: Endpoint, stem: string, context: RowContext): Html => {
	const { head, tail } = leafLabel(endpoint.route, stem)
	const mix = knownStatusMix(endpoint)
	const isSelected = context.selected === endpoint.spanName
	const isSlowest = context.slowest === endpoint.spanName
	const isQuiet = callsPerSecond(endpoint.estimatedSpanCount, context.seconds) < 0.1
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-3")],
						[
							// The row's click opens the drawer; this button is its keyboard and screen-reader trigger.
							h.button(
								[
									h.Type("button"),
									h.Class("sr-only focus:not-sr-only"),
									h.AriaHasPopup("dialog"),
									h.AriaExpanded(isSelected),
									h.AriaLabel(`Open ${endpoint.spanName}`),
								],
								[],
							),
							methodLabel(h, endpoint.method, "w-8 md:w-10"),
							truncatedText(h, { text: endpoint.route, className: "text-ui" }, [
								...(head.length > 0
									? [h.span([h.Class("hidden text-muted-foreground md:inline")], [head])]
									: []),
								h.span([h.Class("text-foreground")], [tail]),
							]),
							...(isSlowest
								? [
										h.span(
											[
												h.Class(
													"hidden shrink-0 rounded-sm bg-muted px-1.5 text-3xs text-warning-foreground md:inline",
												),
											],
											["slowest"],
										),
									]
								: []),
						],
					),
				],
				cn("max-w-0 py-0 align-middle", stem.length > 0 ? "pl-9" : "pl-4"),
			),
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex items-center justify-end gap-3")],
						[
							context.theme === null
								? h.div([h.Class("hidden h-5 w-[88px] md:block")])
								: sparkline(h, {
										chartId: `endpoint-${endpoint.spanName}`,
										values: context.sparks.get(endpoint.spanName) ?? [],
										token: SPARK_TOKENS.requests,
										theme: context.theme,
										className: cn(
											"hidden h-5 w-[88px] md:block",
											isQuiet && "opacity-60",
										),
										toMessage: (message) =>
											Message.GotChartMessage({ chartId: "sparkline", message }),
									}),
							h.span(
								[
									h.Class(
										cn(
											"w-12 text-right",
											isQuiet ? "text-muted-foreground" : "text-foreground",
										),
									),
								],
								[rateText(endpoint, context.seconds)],
							),
						],
					),
				],
				cn(numeric, "py-0 pr-0", COLUMN.rate),
			),
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex items-center justify-end gap-3")],
						[
							statusMixBar(h, mix, "hidden w-24 md:flex"),
							h.span(
								[h.Class("w-12 text-right")],
								[shareText(h, mix?.client ?? null, "text-warning-foreground")],
							),
						],
					),
				],
				cn(numeric, "py-0 pr-0", COLUMN.mix),
			),
			tableCell(
				h,
				[shareText(h, serverShare(endpoint), "text-destructive-foreground")],
				cn(numeric, "py-0 pr-0", COLUMN.err),
			),
			latencyCell(h, endpoint.p50DurationMs, "p50", isSlowest, COLUMN.p50),
			latencyCell(h, endpoint.p95DurationMs, "p95", isSlowest, COLUMN.p95),
			latencyCell(h, endpoint.p99DurationMs, "p99", false, COLUMN.p99),
			tableCell(
				h,
				[
					endpoint.requestBodyCount === 0
						? "—"
						: formatBytes(endpoint.requestBodyBytes / endpoint.requestBodyCount),
				],
				cn(numeric, "py-0 pr-0 text-muted-foreground", COLUMN.body),
			),
			tableCell(
				h,
				[
					icon(h, "ChevronRightIcon", {
						size: 16,
						className: cn("ml-auto", isSelected ? "text-foreground" : "text-muted-foreground"),
					}),
				],
				cn("py-0 pr-4 align-middle", COLUMN.chevron),
			),
		],
		cn(
			"group/row h-12 cursor-pointer border-b text-ui last:border-b-0 has-[button:focus-visible]:ring-1 has-[button:focus-visible]:ring-ring has-[button:focus-visible]:ring-inset",
			isSelected ? "bg-accent hover:bg-accent" : "hover:bg-muted/40",
		),
		[h.Key(endpoint.spanName), h.OnClick(Message.ClickedEndpoint({ spanName: endpoint.spanName }))],
	)
}

/** `GroupHeaderRow`: the group's totals; p95/p99 are the worst in the group. */
const groupHeaderRow = (
	h: H,
	options: Readonly<{
		title: string
		count: string
		group: EndpointGroup<Endpoint>
		seconds: number
		muted: boolean
	}>,
) => {
	const { group } = options
	const sum = (pick: (endpoint: Endpoint) => number) =>
		group.endpoints.reduce((acc, endpoint) => acc + pick(endpoint), 0)
	const mix = knownStatusMix({
		httpClassifiedSpanCount: sum((endpoint) => endpoint.httpClassifiedSpanCount),
		httpStatusCount: sum((endpoint) => endpoint.httpStatusCount),
		http4xxCount: sum((endpoint) => endpoint.http4xxCount),
		http5xxCount: sum((endpoint) => endpoint.http5xxCount),
	})
	const cell = (text: string, width: string, tone?: string) =>
		tableCell(h, [text], cn(numeric, "py-0 pr-0 text-2xs text-muted-foreground", tone, width))
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							icon(h, "ChevronDownIcon", {
								size: 14,
								className: "shrink-0 text-muted-foreground",
							}),
							h.span(
								[
									h.Class(
										cn(
											"truncate text-ui",
											options.muted ? "text-muted-foreground" : "text-foreground",
										),
									),
									h.Title(options.title),
								],
								[options.title],
							),
							h.span([h.Class("shrink-0 text-2xs text-muted-foreground")], [options.count]),
						],
					),
				],
				"max-w-0 py-0 pl-4 align-middle",
			),
			cell(formatRate(callsPerSecond(group.totals.estimatedSpanCount, options.seconds)), COLUMN.rate),
			cell(mix === null ? "—" : formatErrorRate(mix.client), COLUMN.mix),
			cell(
				formatErrorRate(mix === null ? group.totals.errorRate : mix.server),
				COLUMN.err,
				(mix === null ? group.totals.errorRate : mix.server) > 0
					? "text-destructive-foreground"
					: undefined,
			),
			cell("—", COLUMN.p50),
			cell(formatLatencyText(group.totals.p95DurationMs), COLUMN.p95),
			cell(formatLatencyText(group.totals.p99DurationMs), COLUMN.p99),
			cell("—", COLUMN.body),
			tableCell(h, [], COLUMN.chevron),
		],
		"h-10 border-b bg-muted/30 hover:bg-muted/30",
	)
}

const formatLatencyText = (ms: number) => (ms > 0 ? formatLatency(ms) : "—")

/** `GroupRows`: a collapsed bucket with its explainer, or a stem header and its rows. */
export const groupRows = (
	h: H,
	group: EndpointGroup<Endpoint>,
	context: RowContext,
	isExpanded: boolean,
): ReadonlyArray<Html> => {
	if (group.kind === "unrouted" || group.kind === "probes") {
		const copy = COLLAPSED_COPY[group.kind]
		const sample = group.endpoints.slice(0, 2).map((endpoint) => endpoint.route)
		const remaining = group.endpoints.length - sample.length
		return [
			groupHeaderRow(h, {
				title: copy.label,
				count: countLabel(group.endpoints.length, "path"),
				group,
				seconds: context.seconds,
				muted: true,
			}),
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
												[h.Class("truncate text-2xs text-muted-foreground/50")],
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
						"py-2.5 pl-4 pr-4",
						[h.Attribute("colspan", String(COLUMN_COUNT))],
					),
				],
				"border-b hover:bg-transparent",
			),
			...(isExpanded ? group.endpoints.map((endpoint) => endpointRow(h, endpoint, "", context)) : []),
		]
	}
	return [
		...(group.kind === "stem"
			? [
					groupHeaderRow(h, {
						title: group.stem,
						count: countLabel(group.endpoints.length, "endpoint"),
						group,
						seconds: context.seconds,
						muted: false,
					}),
				]
			: []),
		...group.endpoints.map((endpoint) => endpointRow(h, endpoint, group.stem, context)),
	]
}

export const groupsOf = (
	endpoints: ReadonlyArray<Endpoint>,
	sort: { key: string | null; dir: "asc" | "desc" },
): ReadonlyArray<EndpointGroup<Endpoint>> => groupEndpoints(endpoints, endpointSortOf(sort.key), sort.dir)

/** The rows in screen order (collapsed buckets only when opened): what the drawer steps through. */
export const visibleEndpoints = (
	groups: ReadonlyArray<EndpointGroup<Endpoint>>,
	expanded: ReadonlyArray<string>,
): ReadonlyArray<Endpoint> =>
	groups.flatMap((group) =>
		(group.kind === "unrouted" || group.kind === "probes") && !expanded.includes(group.kind)
			? []
			: group.endpoints,
	)

const ENDPOINT_SORTS: ReadonlyArray<EndpointSort> = ["traffic", "path", "errorRate", "p50", "p95", "p99"]
const endpointSortOf = (key: string | null): EndpointSort =>
	ENDPOINT_SORTS.find((sort) => sort === key) ?? "traffic"
