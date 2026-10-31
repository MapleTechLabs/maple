import { EMPTY_VALUE } from "@maple/ui/lib/empty-value"
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
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ThemeColors } from "../../../charts/theme-colors"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { tableCell, tableRow } from "../../../ui/table"
import { truncatedText } from "../../../ui/truncated-text"
import { emptyValue, latencyValue, measure, NIL_VALUE } from "../../../ui/values"
import { callsPerSecond } from "./derive"
import { knownStatusMix, serverShare, type StatusMix } from "./derive-api"
import { Message } from "./message"
import type { Endpoint } from "./model-tabs"
import { SPARK_TOKENS, sparkline } from "./view-api-charts"

// The API tab: endpoint rows and group rows.

type H = HtmlBuilder<Message>

/** Below `md` the table keeps the endpoint, its rate, 4xx share and p95; the rest hide. */
export const COLUMN = {
	rate: "w-14 md:w-44",
	mix: "w-12 md:w-44",
	err: "hidden w-20 md:table-cell",
	p50: "hidden w-20 md:table-cell",
	p95: "w-16 md:w-20",
	p99: "hidden w-20 md:table-cell",
	body: "hidden w-24 md:table-cell",
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
	/** Every listed endpoint uses one method, so its tint would repeat on every row and say nothing. */
	isOneMethod: boolean
}>

/** `methodTone`: only the mutating verbs are tinted. */
const methodTone = (method: string): string =>
	method === "POST" || method === "PUT" || method === "PATCH"
		? "text-severity-warn"
		: method === "DELETE"
			? "text-severity-error"
			: "text-muted-foreground"

export const methodLabel = <M>(h: HtmlBuilder<M>, method: string, className = "w-10", isTinted = true): Html =>
	h.span(
		[
			h.Class(
				cn(
					"shrink-0 text-2xs font-medium uppercase",
					isTinted ? methodTone(method) : "text-muted-foreground",
					className,
				),
			),
		],
		[method],
	)

const COLLAPSED_COPY = {
	unrouted: {
		label: "Unrouted paths",
		explainer: "URL paths rather than route templates. Each distinct id counts as its own endpoint.",
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
					h.div([h.Class(cn("h-full", TONE_FILL.ok)), h.Style({ width: `${mix.ok * 100}%` })]),
					h.div([
						h.Class(cn("h-full", TONE_FILL.warn)),
						h.Style({ width: `${mix.client * 100}%` }),
					]),
					h.div([
						h.Class(cn("h-full", TONE_FILL.crit)),
						h.Style({ width: `${mix.server * 100}%` }),
					]),
				],
	)

/** A share as the table prints it: zero and unknown in the nil grey, anything else toned. */
const shareText = (h: H, share: number | null, tone: string): Html =>
	share === null
		? emptyValue(h)
		: h.span([h.Class(share === 0 ? NIL_VALUE : tone)], [formatErrorRate(share)])

const rateText = (endpoint: Endpoint, seconds: number) =>
	formatRate(callsPerSecond(endpoint.estimatedSpanCount, seconds))

// The "slowest" tag on the route carries the highlight; the latency cells stay plain.
const latencyCell = (h: H, ms: number, scale: "p50" | "p95" | "p99", width: string) =>
	tableCell(h, [latencyValue(h, { ms, scale, className: "text-ui" })], cn(numeric, "py-0 pr-0", width))

const endpointRow = (
	h: H,
	endpoint: Endpoint,
	stem: string,
	context: RowContext,
	/** A sibling shares this row's route, so only the method tells them apart. */
	isRouteShared = false,
): Html => {
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
									h.Class("sr-only"),
									h.AriaHasPopup("dialog"),
									h.AriaExpanded(isSelected),
									h.AriaLabel(`Open ${endpoint.spanName}`),
								],
								[],
							),
							methodLabel(
								h,
								endpoint.method,
								// Narrow screens drop the method unless a sibling shares the route.
								isRouteShared ? "w-9 md:w-10" : "hidden w-10 md:inline-block",
								!context.isOneMethod,
							),
							truncatedText(h, { text: endpoint.route, className: "text-ui" }, [
								...(head.length > 0
									? [
											h.span(
												// A grouped row's head repeats its stem, so it folds away on narrow screens.
												[
													h.Class(
														cn(
															"text-muted-foreground",
															stem.length > 0 && "hidden md:inline",
														),
													),
												],
												[head],
											),
										]
									: []),
								h.span(
									[
										// A shared index row reads as its method on narrow screens; the header names the path.
										h.Class(
											cn(
												"text-foreground",
												isRouteShared && tail === "(index)" && "hidden md:inline",
											),
										),
									],
									[tail],
								),
							]),
							...(isSlowest
								? [
										h.span(
											[
												h.Class(
													cn(
														"hidden shrink-0 rounded-sm bg-muted px-1.5 text-3xs md:inline",
														TONE_TEXT.warn,
													),
												),
											],
											["slowest"],
										),
									]
								: []),
						],
					),
				],
				cn("max-w-0 py-0 align-middle", stem.length > 0 ? "pl-6 md:pl-9" : "pl-4"),
			),
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex items-center justify-end gap-3")],
						[
							// The wrapper hides it on narrow screens; the chart keeps its own flex layout.
							h.div(
								[h.Class("hidden h-5 w-24 md:block")],
								context.theme === null
									? []
									: [
											sparkline(h, {
												chartId: `endpoint-${endpoint.spanName}`,
												values: context.sparks.get(endpoint.spanName) ?? [],
												token: SPARK_TOKENS.requests,
												theme: context.theme,
												className: cn("h-5 w-24", isQuiet && "opacity-60"),
												toMessage: (message) =>
													Message.GotChartMessage({
														chartId: "sparkline",
														message,
													}),
											}),
										],
							),
							h.span(
								[
									h.Class(
										cn(
											"w-12 text-right",
											isQuiet ? "text-muted-foreground" : "text-foreground",
										),
									),
									// A sampled endpoint's rate is scaled up from its traced spans.
									...(endpoint.estimatedSpanCount > endpoint.spanCount
										? [h.Title("Estimated from sampled traces")]
										: []),
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
								[shareText(h, mix?.client ?? null, TONE_TEXT.warn)],
							),
						],
					),
				],
				cn(numeric, "py-0 pr-0", COLUMN.mix),
			),
			tableCell(
				h,
				[shareText(h, serverShare(endpoint), TONE_TEXT.crit)],
				cn(numeric, "py-0 pr-0", COLUMN.err),
			),
			latencyCell(h, endpoint.p50DurationMs, "p50", COLUMN.p50),
			latencyCell(h, endpoint.p95DurationMs, "p95", COLUMN.p95),
			latencyCell(h, endpoint.p99DurationMs, "p99", COLUMN.p99),
			tableCell(
				h,
				[
					...(endpoint.requestBodyCount === 0
						? [emptyValue(h)]
						: measure(
								h,
								formatBytes(endpoint.requestBodyBytes / endpoint.requestBodyCount),
								"text-foreground-subtle",
							)),
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
			isSelected ? "bg-accent hover:bg-accent active:bg-accent" : "hover:bg-surface-sunken active:bg-surface-sunken",
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
		tableCell(
			h,
			// Muted totals drop the unit to subtle; a toned total keeps it in the tone.
			text === EMPTY_VALUE ? [emptyValue(h)] : measure(h, text, tone === undefined ? "text-foreground-subtle" : null),
			cn(numeric, "py-0 pr-0 text-2xs text-muted-foreground", tone, width),
		)
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
								className: "hidden shrink-0 text-muted-foreground md:block",
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
							h.span(
								[h.Class("hidden shrink-0 text-2xs text-muted-foreground md:inline")],
								[options.count],
							),
						],
					),
				],
				"max-w-0 py-0 pl-4 align-middle",
			),
			cell(formatRate(callsPerSecond(group.totals.estimatedSpanCount, options.seconds)), COLUMN.rate),
			cell(mix === null ? EMPTY_VALUE : formatErrorRate(mix.client), COLUMN.mix),
			cell(
				formatErrorRate(mix === null ? group.totals.errorRate : mix.server),
				COLUMN.err,
				(mix === null ? group.totals.errorRate : mix.server) > 0 ? TONE_TEXT.crit : undefined,
			),
			cell(EMPTY_VALUE, COLUMN.p50),
			cell(formatLatencyText(group.totals.p95DurationMs), COLUMN.p95),
			cell(formatLatencyText(group.totals.p99DurationMs), COLUMN.p99),
			cell(EMPTY_VALUE, COLUMN.body),
			tableCell(h, [], COLUMN.chevron),
		],
		"h-10 border-b bg-surface-sunken hover:bg-surface-strong active:bg-surface-strong",
	)
}

const formatLatencyText = (ms: number) => (ms > 0 ? formatLatency(ms) : EMPTY_VALUE)

/** Whether a sibling in the group serves the same route, so only the method tells them apart. */
const sharesRoute = (endpoints: ReadonlyArray<Endpoint>, endpoint: Endpoint) =>
	endpoints.some((other) => other !== endpoint && other.route === endpoint.route)

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
												[h.Class("truncate text-2xs text-foreground-faint")],
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
				"border-b hover:bg-transparent active:bg-transparent",
			),
			...(isExpanded
				? group.endpoints.map((endpoint) =>
						endpointRow(h, endpoint, "", context, sharesRoute(group.endpoints, endpoint)),
					)
				: []),
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
		...group.endpoints.map((endpoint) =>
			endpointRow(h, endpoint, group.stem, context, sharesRoute(group.endpoints, endpoint)),
		),
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
