import { countLabel, formatErrorRate, formatThroughput, pluralize } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { ERROR_RATE_COLOR, errorRateLevel } from "@maple/ui/lib/error-rate"
import { cn } from "@maple/ui/lib/utils"
import { statusDot } from "../../../ui/status-dot"
import { tableCellStyles as tableCellClass, tableRowStyles } from "@maple/ui/styles/ui/table"
import { HEALTH_TONE } from "../../../components/dashboard/service-health"
import { Option } from "effect"
import { AsyncData as FoldkitAsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { AppRoute, hrefOf } from "../../../route"
import * as Sparkline from "../../../charts/sparkline"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { meter } from "../../../ui/meter"
import { middleTruncate } from "../../../ui/middle-truncate"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { tableSkeleton } from "../../../ui/table-skeleton"
import { errorRateValue, latencyValue, serviceDot } from "../../../ui/values"
import { signalEmptyState } from "../../kit/signal-empty-state"
import { presenceOf } from "../../kit/signal-presence"
import {
	baselineDelta,
	baselineKey,
	baselineMapOf,
	deployInfo,
	displayedServices,
	groupServices,
	hasActiveServiceFilters,
	type HealthSummary,
	healthOf,
	isResolvableSha,
	NO_NAMESPACE,
	resolveGroupBy,
	type ServiceHealth,
} from "./derive"
import { MountTable } from "./command"
import { Message } from "./message"
import type { Model, ServiceRow } from "./model"
import { isUnnamedService, type Overlays, rowIdOf, unnamedServiceHint, withOverlays } from "./view-overlays"

/** The Throughput chart's colour, so every calls sparkline across the service pages matches. */
export const THROUGHPUT_COLOR = "--chart-throughput"
const CHART_MODEL = Chart.init()
const toSparklineMessage = (message: Chart.Message) => Message.GotSparklineMessage({ message })
const SERVICE_OVERVIEW_ROW_CAP = 500
const TEXT_HALO =
	"[text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]"

export type TableContext = Readonly<{
	model: Model
	summary: HealthSummary | undefined
	theme: ThemeColors | null
	isNamespacePinned: boolean
	timeZone: string
	/** The row tooltips' and commit card's trigger attributes (`withOverlays`). */
	overlays?: Overlays
}>

const truncateCommitSha = (sha: string): string =>
	sha === "N/A" || sha === "unknown" || !sha ? "N/A" : shortId(sha, "sha")

const healthDot = (h: HtmlBuilder<Message>, health: ServiceHealth | undefined): Html | null =>
	health === undefined || health === "healthy"
		? null
		: statusDot(h, {
				tone: HEALTH_TONE[health],
				attributes: [h.AriaHidden(false), h.AriaLabel(health), h.Title(health)],
			})

const environmentBadge = (h: HtmlBuilder<Message>, environment: string): Html => {
	const tint =
		environment.toLowerCase() === "production"
			? "bg-severity-warn-a2 text-severity-warn"
			: environment.toLowerCase() === "staging"
				? "bg-chart-p50/15 text-chart-p50"
				: environment.toLowerCase() === "development"
					? "bg-severity-debug-a2 text-severity-debug"
					: ""
	return badge(h, { variant: "secondary", className: tint }, [environment])
}

const namespaceLabel = (h: HtmlBuilder<Message>, namespace: string): Html =>
	namespace === NO_NAMESPACE
		? badge(h, { variant: "secondary", className: "text-muted-foreground" }, ["No namespace"])
		: badge(h, { variant: "secondary" }, [namespace])

const sparkline = (
	h: HtmlBuilder<Message>,
	ctx: TableContext,
	slotId: string,
	values: ReadonlyArray<number>,
	color: string,
): Html =>
	ctx.theme === null || ctx.model.chartRuntime._tag !== "Ready"
		? h.div([h.Class("absolute inset-0 h-full w-full")], [])
		: h.submodel({
				slotId,
				model: CHART_MODEL,
				view: Sparkline.view,
				toParentMessage: toSparklineMessage,
				viewInputs: {
					chartId: slotId,
					values,
					color: resolveColor(ctx.theme, color),
					className: "absolute inset-0 h-full w-full",
					revision: ctx.model.rowRevision,
				},
			})

/** The deploy cell's lines: commit subject (once resolved) over `sha · age`, or the state line. */
const deployCell = (h: HtmlBuilder<Message>, ctx: TableContext, service: ServiceRow): Html => {
	const info = deployInfo(service.commits)
	if (info === undefined) return h.span([h.Class("text-xs text-muted-foreground")], ["N/A"])
	const age =
		info.firstSeen !== "" ? formatRelativeTimeOrDate(info.firstSeen, ctx.model.nowMs, ctx.timeZone) : ""
	const messages: Readonly<Record<string, string>> = Option.getOrElse(
		FoldkitAsyncData.getData(ctx.model.commitMessages.data),
		() => ({}),
	)
	const message = isResolvableSha(info.sha) ? (messages[info.sha] ?? "") : ""
	const shortSha = truncateCommitSha(info.sha)
	const metaText = message !== "" ? [shortSha, age].filter(Boolean).join(" · ") : age
	const stateLine: Html | null = info.errorsSince
		? h.span(
				[h.Class("truncate text-3xs text-severity-error")],
				[...(age !== "" ? [`${age} · `] : []), "errors ↑ since"],
			)
		: info.rollout !== undefined
			? h.button(
					[
						h.Class("flex cursor-default items-center gap-1.5"),
						h.DataAttribute("base-ui-tooltip-trigger", ""),
						h.DataAttribute("slot", "tooltip-trigger"),
						h.Type("button"),
						...(ctx.overlays?.tooltip("rollout", rowIdOf(service)) ?? []),
					],
					[
						meter(h, {
							value: info.rollout.percentage,
							max: 100,
							className: "h-[3px] w-10 shrink-0 bg-muted",
							fillClassName: "bg-primary",
						}),
						h.span(
							[h.Class("font-mono text-3xs text-primary")],
							[String(info.rollout.percentage), "% · +", String(info.rollout.others.length)],
						),
					],
				)
			: null
	const trigger = isResolvableSha(info.sha)
		? h.span(
				[
					h.Class("cursor-default min-w-0 max-w-full truncate text-xs text-foreground"),
					h.DataAttribute("slot", "hover-card-trigger"),
					...(ctx.overlays?.commit(rowIdOf(service), info.sha) ?? []),
				],
				[message !== "" ? message : shortSha],
			)
		: h.span([h.Class("min-w-0 max-w-full truncate text-xs text-foreground")], [shortSha])
	return h.div(
		[h.Class("flex min-w-0 flex-col gap-0.5")],
		[
			trigger,
			stateLine ??
				(metaText === ""
					? null
					: h.span([h.Class("truncate font-mono text-3xs text-muted-foreground")], [metaText])),
		],
	)
}

const serviceRow = (
	h: HtmlBuilder<Message>,
	ctx: TableContext,
	service: ServiceRow,
	subtitle: string,
	baselines: ReturnType<typeof baselineMapOf> | undefined,
	groupPath: string,
): Html => {
	const health = healthOf(ctx.summary, service)
	const series = FoldkitAsyncData.getData(ctx.model.sparklines.data).pipe(
		Option.flatMap((map) =>
			Option.fromNullishOr(
				Object.hasOwn(map, service.serviceName) ? map[service.serviceName] : undefined,
			),
		),
	)
	const throughput = Option.match(series, { onNone: () => [], onSome: (s) => s.throughput })
	const errorRates = Option.match(series, { onNone: () => [], onSome: (s) => s.errorRate })
	const delta = baselineDelta(
		service.p95LatencyMs,
		baselines?.get(baselineKey(service.serviceName, service.serviceNamespace, service.environment)),
	)
	// Rows are keyed inside their namespace and environment groups, so a regrouped row remounts.
	const rowKey = `${groupPath}/${service.serviceName}-${service.serviceNamespace}-${service.environment}`
	const open = Message.ClickedServiceRow({
		serviceName: service.serviceName,
		environment: service.environment,
	})
	const throughputText = formatThroughput(service.throughput, "/s")
	return h.tr(
		[
			h.Key(rowKey),
			h.Attribute(
				"class",
				cn(
					tableRowStyles,
					"cursor-pointer border-l-2 border-l-transparent hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
					health === "unhealthy" && "border-l-severity-error",
				),
			),
			h.DataAttribute("slot", "table-row"),
			h.Tabindex(0),
			h.OnClick(open),
			h.OnKeyDownPreventDefault((key) =>
				key === "Enter" || key === " " ? Option.some(open) : Option.none(),
			),
		],
		[
			tableCell(h, [
				h.a(
					[
						h.Class(
							"flex max-w-full items-center gap-1.5 font-medium text-foreground hover:underline active:underline",
						),
						h.Href(serviceHref(ctx.model, service)),
						h.Title(service.serviceName),
					],
					[
						serviceDot(h, { serviceName: service.serviceName }),
						h.span([h.Class("min-w-0 truncate")], [service.serviceName]),
						isUnnamedService(service.serviceName)
							? unnamedServiceHint(h, ctx.overlays?.tooltip("unnamed", rowIdOf(service)) ?? [])
							: null,
						healthDot(h, health),
					],
				),
				...(subtitle !== ""
					? [h.div([h.Class("truncate text-xs text-muted-foreground")], [subtitle])]
					: []),
			]),
			tableCell(
				h,
				[latencyValue(h, { ms: service.p50LatencyMs, scale: "p50" })],
				"hidden lg:table-cell text-xs",
			),
			tableCell(
				h,
				[
					h.div([], [latencyValue(h, { ms: service.p95LatencyMs, scale: "p95" })]),
					...(delta === undefined
						? []
						: [h.div([h.Class(cn("text-3xs tabular-nums", delta.className))], [delta.label])]),
				],
				"text-xs",
			),
			tableCell(
				h,
				[latencyValue(h, { ms: service.p99LatencyMs, scale: "p99" })],
				"hidden lg:table-cell text-xs",
			),
			tableCell(h, [
				h.div(
					[
						h.Class("relative h-8 w-full max-w-[120px]"),
						h.Role("img"),
						h.AriaLabel(`Error rate: ${formatErrorRate(service.errorRate)}`),
					],
					[
						sparkline(
							h,
							ctx,
							`err-${rowKey}`,
							errorRates,
							ERROR_RATE_COLOR[errorRateLevel(service.errorRate)],
						),
						h.div(
							[h.Class("absolute inset-0 flex items-center justify-center")],
							[
								errorRateValue(h, {
									rate: service.errorRate,
									className: cn("text-xs font-semibold", TEXT_HALO),
								}),
							],
						),
					],
				),
			]),
			tableCell(
				h,
				[
					h.button(
						[
							h.AriaLabel(`Throughput: ${throughputText}`),
							h.Class("relative block h-8 w-full max-w-[120px]"),
							h.DataAttribute("base-ui-tooltip-trigger", ""),
							h.DataAttribute("slot", "tooltip-trigger"),
							h.Type("button"),
							...(service.hasSampling
								? (ctx.overlays?.tooltip("sampling", rowIdOf(service)) ?? [])
								: []),
						],
						[
							sparkline(h, ctx, `thr-${rowKey}`, throughput, THROUGHPUT_COLOR),
							h.div(
								[h.Class("absolute inset-0 flex flex-col items-center justify-center")],
								[
									h.span(
										[h.Class(cn("font-mono text-xs font-semibold", TEXT_HALO))],
										[...(service.hasSampling ? ["~"] : []), throughputText],
									),
									...(service.hasSampling
										? [
												h.span(
													[
														h.Class(
															cn(
																"font-mono text-4xs text-muted-foreground",
																TEXT_HALO,
															),
														),
													],
													[
														"~",
														formatThroughput(service.tracedThroughput, "/s"),
														" traced",
													],
												),
											]
										: []),
								],
							),
						],
					),
				],
				"hidden md:table-cell",
			),
			tableCell(h, [deployCell(h, ctx, service)], "hidden lg:table-cell"),
		],
	)
}

/** `serviceDetailSearch`: the row's environment plus the list's window. */
const serviceHref = (model: Model, service: ServiceRow): string =>
	hrefOf(
		AppRoute.Service({
			serviceName: service.serviceName,
			search: {
				startTime: model.search.startTime,
				endTime: model.search.endTime,
				timePreset: model.search.timePreset,
				environments: [service.environment],
			},
		}),
	)

const COLUMNS: ReadonlyArray<readonly [label: string, className: string | undefined]> = [
	["Service", undefined],
	["P50", "hidden lg:table-cell w-[6%]"],
	["P95", "w-[9%]"],
	["P99", "hidden lg:table-cell w-[7%]"],
	["Error rate", "w-[12%]"],
	["Throughput", "hidden md:table-cell w-[12%]"],
	["Last deploy", "hidden lg:table-cell w-[18%]"],
]

const groupHeaderRow = (
	h: HtmlBuilder<Message>,
	key: string,
	tint: string,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.tr(
		[h.Key(key), h.Attribute("class", cn(tableRowStyles, tint)), h.DataAttribute("slot", "table-row")],
		[
			h.td(
				[
					h.Attribute("class", cn(tableCellClass, "py-2")),
					h.Attribute("colspan", "7"),
					h.DataAttribute("slot", "table-cell"),
				],
				[h.div([h.Class(cn("flex items-center gap-2", className))], children)],
			),
		],
	)

const emptyState = (h: HtmlBuilder<Message>, ctx: TableContext) => {
	const isFiltered = hasActiveServiceFilters(ctx.model.search)
	return h.div([h.Class("contents")], [emptyStateBody(h, ctx, isFiltered)])
}

const emptyStateBody = (h: HtmlBuilder<Message>, ctx: TableContext, isFiltered: boolean) => {
	return signalEmptyState(h, {
		signal: "traces",
		noun: "services",
		presence: presenceOf(ctx.model.presence, "traces"),
		nowMs: ctx.model.nowMs,
		isFiltered,
		onClearFilters: isFiltered ? Message.ClickedClearServiceFilters() : undefined,
	})
}

const desktopTable = (
	h: HtmlBuilder<Message>,
	ctx: TableContext,
	services: ReadonlyArray<ServiceRow>,
	mode: "namespace" | "environment",
): Html => {
	const baselines = Option.getOrUndefined(
		Option.map(FoldkitAsyncData.getData(ctx.model.baseline.data), baselineMapOf),
	)
	const subtitleFor = (service: ServiceRow) => (mode === "namespace" ? "" : service.serviceNamespace)
	const body =
		services.length === 0
			? [
					tableRow(h, [
						h.td(
							[
								h.Attribute("class", cn(tableCellClass, "p-0")),
								h.Attribute("colspan", "7"),
								h.DataAttribute("slot", "table-cell"),
							],
							[emptyState(h, ctx)],
						),
					]),
				]
			: groupServices(services, mode).flatMap(([namespace, envGroups]) => [
					...(mode === "namespace"
						? [
								groupHeaderRow(h, `ns-${namespace}`, "bg-surface-sunken hover:bg-surface-strong active:bg-surface-strong", [
									namespaceLabel(h, namespace),
									h.span(
										[h.Class("text-xs text-muted-foreground")],
										[
											countLabel(
												envGroups.reduce((sum, [, rows]) => sum + rows.length, 0),
												"service",
											),
										],
									),
								]),
							]
						: []),
					...envGroups.flatMap(([environment, rows]) => [
						groupHeaderRow(
							h,
							`env-${namespace}-${environment}`,
							"bg-surface-sunken hover:bg-surface-strong active:bg-surface-strong",
							[
								environmentBadge(h, environment),
								h.span(
									[h.Class("text-xs text-muted-foreground")],
									[String(rows.length), " ", pluralize(rows.length, "service")],
								),
							],
							mode === "namespace" ? "pl-4" : undefined,
						),
						...rows.map((service) =>
							serviceRow(
								h,
								ctx,
								service,
								subtitleFor(service),
								baselines,
								`${namespace}/${environment}`,
							),
						),
					]),
				])
	return h.div(
		[h.Class("hidden md:block rounded-md border overflow-auto"), h.OnMount(MountTable())],
		[
			table(h, { className: "w-full table-fixed", ariaLabel: "Services" }, [
				tableHeader(h, [
					tableRow(
						h,
						COLUMNS.map(([label, className]) => tableHead(h, [label], className)),
					),
				]),
				tableBody(h, body),
			]),
		],
	)
}

/** Below `md`: the stacked tap-to-drill list. */
const mobileList = (
	h: HtmlBuilder<Message>,
	ctx: TableContext,
	services: ReadonlyArray<ServiceRow>,
	mode: "namespace" | "environment",
): Html =>
	h.div(
		[h.Class("overflow-hidden rounded-md border md:hidden")],
		services.length === 0
			? [emptyState(h, ctx)]
			: groupServices(services, mode).map(([namespace, envGroups]) =>
					h.div(
						[h.Key(`m-${namespace}`)],
						[
							...(mode === "namespace"
								? [
										h.div(
											[
												h.Class(
													"flex items-center gap-2 border-b bg-surface-sunken px-3 py-2",
												),
											],
											[
												namespaceLabel(h, namespace),
												h.span(
													[h.Class("text-xs text-muted-foreground")],
													[
														countLabel(
															envGroups.reduce(
																(sum, [, rows]) => sum + rows.length,
																0,
															),
															"service",
														),
													],
												),
											],
										),
									]
								: []),
							...envGroups.map(([environment, rows]) =>
								h.div(
									[h.Key(`m-${namespace}-${environment}`)],
									[
										h.div(
											[
												h.Class(
													cn(
														"flex items-center gap-2 border-b bg-surface-sunken px-3 py-2",
														mode === "namespace" && "pl-6",
													),
												),
											],
											[
												environmentBadge(h, environment),
												h.span(
													[h.Class("text-xs text-muted-foreground")],
													[countLabel(rows.length, "service")],
												),
											],
										),
										...rows.map((service) =>
											h.a(
												[
													h.Key(
														`m-${service.serviceName}-${service.serviceNamespace}-${service.environment}`,
													),
													h.Href(serviceHref(ctx.model, service)),
													h.Class(
														"flex min-h-11 items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
													),
												],
												[
													h.div(
														[h.Class("min-w-0 flex-1")],
														[
															h.div(
																[
																	h.Class(
																		"flex items-center gap-1.5 text-sm font-medium text-foreground",
																	),
																],
																[
																	serviceDot(h, {
																		serviceName: service.serviceName,
																	}),
																	middleTruncate(h, {
																		text: service.serviceName,
																		tail: 12,
																	}),
																	isUnnamedService(service.serviceName)
																		? unnamedServiceHint(
																				h,
																				ctx.overlays?.tooltip(
																					"unnamed",
																					rowIdOf(service, true),
																				) ?? [],
																			)
																		: null,
																	healthDot(
																		h,
																		healthOf(ctx.summary, service),
																	),
																],
															),
															...(mode === "environment" &&
															service.serviceNamespace !== ""
																? [
																		h.div(
																			[
																				h.Class(
																					"truncate text-xs text-muted-foreground",
																				),
																			],
																			[service.serviceNamespace],
																		),
																	]
																: []),
															h.div(
																[
																	h.Class(
																		"flex items-center gap-3 font-mono text-xs tabular-nums",
																	),
																],
																// `MobileStat`'s `{label} `: the label and its space are two text nodes.
																[
																	h.span(
																		[],
																		[
																			h.span(
																				[
																					h.Class(
																						"text-foreground-subtle",
																					),
																				],
																				["P99", " "],
																			),
																			latencyValue(h, {
																				ms: service.p99LatencyMs,
																				scale: "p99",
																			}),
																		],
																	),
																	h.span(
																		[],
																		[
																			h.span(
																				[
																					h.Class(
																						"text-foreground-subtle",
																					),
																				],
																				["Thru", " "],
																			),
																			h.span(
																				[h.Class("text-foreground")],
																				[
																					...(service.hasSampling
																						? ["~"]
																						: []),
																					formatThroughput(
																						service.throughput,
																						"/s",
																					),
																				],
																			),
																		],
																	),
																],
															),
														],
													),
													h.div(
														[h.Class("shrink-0 text-right")],
														[
															errorRateValue(h, {
																rate: service.errorRate,
																className: "block text-sm font-semibold",
															}),
															eyebrow(h, { as: "div" }, ["err"]),
														],
													),
												],
											),
										),
									],
								),
							),
						],
					),
				),
	)

const SKELETON_COLUMNS = [
	{ header: "Service", skeleton: "w-32" },
	{ header: "P50", headClassName: "w-[6%]", skeleton: "w-12" },
	{ header: "P95", headClassName: "w-[9%]", skeleton: "w-14" },
	{ header: "P99", headClassName: "w-[7%]", skeleton: "w-12" },
	{ header: "Error rate", headClassName: "w-[12%]", skeleton: "h-8 w-full" },
	{ header: "Throughput", headClassName: "w-[12%]", skeleton: "h-8 w-full" },
	{ header: "Last deploy", headClassName: "w-[18%]", skeleton: "w-24" },
]

/** `LoadingState`. */
export const loadingState = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			tableSkeleton(h, {
				columns: SKELETON_COLUMNS,
				rows: 5,
				tableClassName: "w-full table-fixed",
				className: "hidden overflow-auto md:block",
			}),
			h.div(
				[
					h.AriaBusy(true),
					h.Class("flex flex-col gap-0 overflow-hidden rounded-md border md:hidden"),
					h.DataAttribute("slot", "skeleton-list"),
				],
				Array.from({ length: 5 }, () =>
					h.div(
						[
							h.Class(
								"flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0",
							),
						],
						[
							h.div(
								[h.Class("min-w-0 flex-1 space-y-1.5")],
								[skeleton(h, "h-4 w-32"), skeleton(h, "h-3 w-24")],
							),
							skeleton(h, "h-4 w-12"),
						],
					),
				),
			),
		],
	)

/** The loaded table: grouping control, desktop table, mobile list and the footer tally. */
export const servicesTable = (
	h: HtmlBuilder<Message>,
	ctx: TableContext,
	overview: ReadonlyArray<ServiceRow>,
	isWaiting: boolean,
): Html => {
	const services = displayedServices(overview, ctx.summary, ctx.model.search)
	const hasNamespaces = services.some((service) => service.serviceNamespace !== "")
	const mode = resolveGroupBy(ctx.model.search.groupBy, services, ctx.isNamespacePinned)
	const unhealthy = services.filter((s) => healthOf(ctx.summary, s) === "unhealthy").length
	const degraded = services.filter((s) => healthOf(ctx.summary, s) === "degraded").length
	const healthFilter = ctx.model.search.health
	return withOverlays(
		h,
		ctx.model,
		{ nowMs: ctx.model.nowMs, timeZone: ctx.timeZone },
		services,
		(overlays) =>
			body(
				h,
				{ ...ctx, overlays },
				overview,
				services,
				mode,
				hasNamespaces,
				unhealthy,
				degraded,
				healthFilter,
			),
		(children) =>
			h.div(
				[
					h.Class(cn("space-y-4", refreshingClass(isWaiting))),
					...(isWaiting ? [h.AriaBusy(true)] : []),
				],
				children,
			),
	)
}

const body = (
	h: HtmlBuilder<Message>,
	ctx: TableContext,
	overview: ReadonlyArray<ServiceRow>,
	services: ReadonlyArray<ServiceRow>,
	mode: "namespace" | "environment",
	hasNamespaces: boolean,
	unhealthy: number,
	degraded: number,
	healthFilter: string | undefined,
): ReadonlyArray<Html> => [
	...(hasNamespaces
		? [
				h.div(
					[h.Class("flex items-center justify-end")],
					[
						segmentedSelect(h, {
							options: [
								{ value: "namespace", label: "Namespace" },
								{ value: "environment", label: "Environment" },
							],
							value: mode,
							onChange: (groupBy) => Message.ClickedGroupBy({ groupBy }),
							size: "sm",
							ariaLabel: "Group services by",
							className: "shrink-0",
						}),
					],
				),
			]
		: []),
	desktopTable(h, ctx, services, mode),
	mobileList(h, ctx, services, mode),
	h.div(
		[h.Class("flex items-center justify-between text-sm text-muted-foreground")],
		[
			h.span(
				[],
				[
					overview.length >= SERVICE_OVERVIEW_ROW_CAP
						? `Showing first ${SERVICE_OVERVIEW_ROW_CAP} services`
						: `Showing ${[String(services.length), healthFilter, pluralize(services.length, "service")].filter(Boolean).join(" ")}`,
				],
			),
			...(unhealthy > 0 || degraded > 0
				? [
						h.span(
							[h.Class("text-xs")],
							[
								...(unhealthy > 0 ? [`${unhealthy} unhealthy`] : []),
								...(unhealthy > 0 && degraded > 0 ? [" · "] : []),
								...(degraded > 0 ? [`${degraded} degraded`] : []),
							],
						),
					]
				: []),
		],
	),
]
