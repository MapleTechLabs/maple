import type { HyperdriveNodeInfo } from "@maple/ui/components/service-map/service-map-hyperdrive"
import type { PlanetScaleNodeMetrics } from "@maple/ui/components/service-map/service-map-utils"
import {
	countLabel,
	EMPTY_VALUE,
	formatLatency,
	formatNumber,
	formatPercent,
	formatRate,
	pluralize,
} from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	formatLag,
	formatStoragePercent,
	lagClass,
	utilizationClass,
} from "../../components/infra/planetscale/metrics"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { AppRoute, hrefOf } from "../../route"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { separator } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { skeletonBlock } from "@maple/views/ui/skeleton"
import { truncatedId } from "@maple/views/ui/truncated-id"
import { errorRateValue } from "@maple/views/ui/values"
import { docsLink } from "../kit/signal-empty-state"
import type { Message } from "./message"
import type { DbSummary, Model } from "./model"
import { metricTile, metricValue, sampled, tagBadge } from "@maple/views/service-map/panel/kit"
import { queryActivityCharts } from "./view-db-charts"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { grid } from "@maple/views/ui/grid"

// The database panel's sections: Hyperdrive configs,
// PlanetScale health and branches, query activity and the top query shapes.

type H = HtmlBuilder<Message>

/** A failed read as the panels show it: a small critical Alert with `displayError`'s copy. */
export const failureAlert = <A>(h: H, data: AsyncData.AsyncData<A, LoadFailure>): Option.Option<Html> =>
	Option.map(AsyncData.getError(data), (failure) =>
		alert(h, { variant: "crit", size: "sm" }, [
			alertTitle(h, [failure.title], "text-severity-error"),
			alertDescription(h, [failure.message]),
		]),
	)

const sectionHeading = (h: H, mark: Html, title: string, trailing: ReadonlyArray<Html | string>): Html =>
	hstack(h, { gap: "1.5" }, [
		mark,
		eyebrow(h, { as: "h4" }, [title]),
		h.span([h.Class("ml-auto text-3xs text-muted-foreground")], trailing),
	])

const hyperdriveOrigin = (h: H, config: HyperdriveNodeInfo): Html => {
	if (config.matched !== undefined)
		return h.a(
			[
				h.Class("flex min-w-0 items-center gap-1.5 text-foreground hover:underline active:underline"),
				h.Href(
					hrefOf(AppRoute.InfraPlanetscaleDatabase({ dbName: config.matched.name, search: {} })),
				),
			],
			[
				icon(h, "PlanetScaleIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
				typography(h, { mono: true, truncate: true }, [config.matched.name]),
				typography(h, { size: "3xs", tone: "muted", className: "shrink-0" }, [
					config.matched.kind === "postgresql" ? "Postgres" : "MySQL",
					" on PlanetScale",
				]),
			],
		)
	if (config.isPlanetScaleHost)
		return h.span(
			[h.Class("flex min-w-0 items-center gap-1.5 text-muted-foreground")],
			[
				icon(h, "PlanetScaleIcon", { size: 12, className: "shrink-0" }),
				typography(h, { mono: true, truncate: true }, [config.originDatabase]),
				h.span([h.Class("shrink-0 text-3xs")], ["PlanetScale (not in inventory)"]),
			],
		)
	return h.span(
		[h.Class("flex min-w-0 items-center gap-1.5 text-muted-foreground")],
		[
			typography(h, { mono: true, truncate: true }, [config.originDatabase]),
			config.originHost
				? typography(h, { size: "3xs", tone: "subtle", truncate: true }, [config.originHost])
				: h.span([h.Class("shrink-0 text-3xs text-foreground-subtle")], ["private origin"]),
		],
	)
}

/** `HyperdriveSection`: the org's configs with the origin each one fronts. */
export const hyperdriveSection = (h: H, configs: ReadonlyArray<HyperdriveNodeInfo>): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			separator(h, "horizontal", undefined),
			sectionHeading(
				h,
				icon(h, "CloudflareIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
				"Hyperdrive configs",
				[countLabel(configs.length, "config")],
			),
			h.div(
				[h.Class("space-y-1.5")],
				Arr.map(configs, (config) =>
					panel(h, { className: "px-2.5 py-2 text-xs" }, [
						hstack(h, { gap: "2", justify: "between" }, [
							hstack(h, { gap: "1.5", shrink: true }, [
								h.span([h.Class("truncate font-medium text-foreground")], [config.name]),
								tagBadge(h, [config.originScheme]),
							]),
							truncatedId(h, {
								value: config.id,
								length: 8,
								className: "shrink-0 text-3xs text-foreground-subtle",
							}),
						]),
						h.div(
							[h.Class("mt-1.5 flex items-center gap-1.5 text-2xs")],
							[
								icon(h, "ArrowRightIcon", {
									size: 12,
									className: "shrink-0 text-foreground-subtle",
								}),
								hyperdriveOrigin(h, config),
							],
						),
					]),
				),
			),
		],
	)

const planetscaleStats = (h: H, stats: NonNullable<PlanetScaleNodeMetrics["stats"]>): Html =>
	grid(h, { cols: 2, gapX: "6", gapY: "4" }, [
		metricTile(h, "Connections", metricValue(h, undefined, [formatRate(stats.connectionsAvg)]), [
			"peak ",
			formatRate(stats.connectionsMax),
		]),
		metricTile(
			h,
			"CPU (max)",
			metricValue(h, cn(utilizationClass(stats.cpuMaxPercent)), [
				formatPercent(stats.cpuMaxPercent / 100),
			]),
		),
		metricTile(
			h,
			"Memory (max)",
			metricValue(h, cn(utilizationClass(stats.memMaxPercent)), [
				formatPercent(stats.memMaxPercent / 100),
			]),
		),
		metricTile(
			h,
			"Storage (max)",
			metricValue(
				h,
				cn(stats.storageUsedPercent !== null && utilizationClass(stats.storageUsedPercent)),
				[
					stats.storageUsedPercent === null
						? EMPTY_VALUE
						: formatStoragePercent(stats.storageUsedPercent),
				],
			),
		),
		metricTile(
			h,
			"Replica lag (max)",
			metricValue(h, cn(lagClass(stats.replicaLagMaxSeconds)), [formatLag(stats.replicaLagMaxSeconds)]),
		),
	])

const branchRows = (h: H, model: Model, planetscale: PlanetScaleNodeMetrics): ReadonlyArray<Html> => {
	if (AsyncData.isFailure(model.branchStats.data)) return []
	const branchStats = Option.match(AsyncData.getData(model.branchStats.data), {
		onNone: () => [],
		onSome: (stats) => stats.value.branches,
	})
	const infoByName = new Map(Arr.map(planetscale.branches, (branch) => [branch.name, branch]))
	const statNames = new Set(Arr.map(branchStats, (row) => row.branch))
	const idle = Arr.filter(planetscale.branches, (branch) => !statNames.has(branch.name))
	if (branchStats.length === 0 && idle.length === 0) return []
	return [
		h.div(
			[h.Class("space-y-1.5")],
			[
				...Arr.map(branchStats, (row) =>
					panel(
						h,
						{ className: "flex-row items-center justify-between gap-2 px-2.5 py-2 text-xs" },
						[
							hstack(h, { gap: "1.5", shrink: true }, [
								h.span(
									[h.Class("truncate font-mono text-2xs text-foreground")],
									[row.branch],
								),
								...(infoByName.get(row.branch)?.production === true
									? [tagBadge(h, ["prod"])]
									: []),
							]),
							h.div(
								[
									h.Class(
										"flex shrink-0 items-center gap-3 font-mono text-3xs tabular-nums text-muted-foreground",
									),
								],
								[
									h.span([], [formatRate(row.connectionsAvg), " conns"]),
									h.span(
										[h.Class(cn(utilizationClass(row.cpuMaxPercent)))],
										[formatPercent(row.cpuMaxPercent / 100), " cpu"],
									),
									h.span(
										[h.Class(cn(lagClass(row.replicaLagMaxSeconds)))],
										[formatLag(row.replicaLagMaxSeconds), " lag"],
									),
								],
							),
						],
					),
				),
				...Arr.map(idle, (branch) =>
					panel(
						h,
						{
							className:
								"flex-row items-center justify-between gap-2 border-border-subtle px-2.5 py-2 text-xs opacity-70",
						},
						[
							hstack(h, { gap: "1.5", shrink: true }, [
								typography(h, { size: "2xs", tone: "muted", mono: true, truncate: true }, [
									branch.name,
								]),
								...(branch.production ? [tagBadge(h, ["prod"])] : []),
							]),
							typography(h, { size: "3xs", tone: "muted", className: "shrink-0" }, [
								branch.ready ? "no metrics" : "not ready",
							]),
						],
					),
				),
			],
		),
	]
}

/**
 * `PlanetScaleSection`: scraped health and the per-branch breakdown.
 * TODO(planetscale-insights): `PlanetScaleTopQueries` (Insights) is not ported; its heading shows alone.
 */
export const planetscaleSection = (h: H, model: Model, planetscale: PlanetScaleNodeMetrics): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			separator(h, "horizontal", undefined),
			sectionHeading(
				h,
				icon(h, "PlanetScaleIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
				"PlanetScale",
				[
					planetscale.kind === "postgresql" ? "Postgres" : "MySQL",
					" · ",
					String(planetscale.branchCount),
					" ",
					pluralize(planetscale.branchCount, "branch", "branches"),
				],
			),
			planetscale.stats === undefined
				? typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"No PlanetScale metrics in this window yet; the scraper delivers them within a minute of connecting.",
					])
				: planetscaleStats(h, planetscale.stats),
			...Option.toArray(failureAlert(h, model.branchStats.data)),
			...branchRows(h, model, planetscale),
			h.div([h.Class("space-y-2")], [eyebrow(h, { as: "h5" }, ["Top queries (PlanetScale Insights)"])]),
		],
	)

type SummaryResponse = DbSummary["value"]

/** `DbQueryActivityChart`: a skeleton while the first answer loads, the empty note, or the two plots. */
export const queryActivity = (
	h: H,
	model: Model,
	response: SummaryResponse | null,
	isWaiting: boolean,
	timeZone: string,
): Html => {
	if (response === null && isWaiting) return skeletonBlock(h, { height: "44" })
	if (response === null || response.timeseries.length === 0)
		return emptyMessage(
			h,
			{
				dashed: true,
				className:
					"flex h-44 flex-col items-center justify-center gap-1.5 border-border-subtle bg-surface-faint text-xs",
			},
			[
				"No database query spans in this window",
				h.span([], ["Database nodes need spans with db.system."]),
				docsLink(h, "otelConventions"),
			],
		)
	return queryActivityCharts(h, model, response, timeZone)
}

/** `formatQueryLabel`: whitespace collapsed, long statements cut in the middle. */
const formatQueryLabel = (value: string): string => {
	const collapsed = Str.trim(Str.replace(/\s+/g, " ")(value))
	if (collapsed.length <= 96) return collapsed || "unknown query"
	return `${Str.slice(0, 78)(collapsed)}…${Str.slice(-16)(collapsed)}`
}

export const topQueries = (h: H, response: SummaryResponse | null): ReadonlyArray<Html> =>
	response === null || response.topQueries.length === 0
		? []
		: [
				h.div(
					[h.Class("space-y-3")],
					[
						separator(h, "horizontal", undefined),
						eyebrow(h, { as: "h4" }, ["Top query shapes"]),
						h.div(
							[h.Class("space-y-1.5")],
							Arr.map(response.topQueries, (query) =>
								panel(h, { className: "px-2.5 py-2" }, [
									hstack(h, { gap: "2", align: "start", justify: "between" }, [
										h.p(
											[
												h.Class(
													"min-w-0 flex-1 truncate font-mono text-2xs font-medium text-foreground",
												),
											],
											[formatQueryLabel(query.queryLabel)],
										),
										errorRateValue(h, {
											rate: query.errorRate,
											className: "shrink-0 text-3xs",
										}),
									]),
									h.div(
										[
											h.Class(
												"mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs text-muted-foreground",
											),
										],
										[
											typography(h, { mono: true, numeric: true }, [
												...sampled(
													query.estimatedQueryCount > query.queryCount + 1,
													formatNumber(query.estimatedQueryCount),
												),
												" ",
												"calls",
											]),
											typography(h, { mono: true, numeric: true }, [
												"p50",
												" ",
												h.span(
													[h.Class(latencyToneClass(query.p50DurationMs, "p50"))],
													[formatLatency(query.p50DurationMs)],
												),
											]),
											typography(h, { mono: true, numeric: true }, [
												"p95",
												" ",
												h.span(
													[h.Class(latencyToneClass(query.p95DurationMs, "p95"))],
													[formatLatency(query.p95DurationMs)],
												),
											]),
											h.span(
												[h.Class("truncate")],
												[
													query.serviceCount > 1
														? `${query.serviceCount} services`
														: query.sampleService,
												],
											),
										],
									),
								]),
							),
						),
					],
				),
			]
