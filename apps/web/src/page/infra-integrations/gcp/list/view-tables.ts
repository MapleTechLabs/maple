import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import {
	gcpQueryInsightsConsoleUrl,
	gcpSqlEngine,
	gcpSqlSize,
} from "../../../../components/infra/gcp/cloud-sql-signals"
import {
	GCP_DATABASE_RULES,
	GCP_FILLING_FRACTION,
	GCP_LIMIT_FRACTION,
	GCP_REPLICA_LAG_SECONDS,
	GCP_SERVICE_RULES,
	GCP_SLOW_P95_SECONDS,
	GCP_STALE_SECONDS,
	GCP_SUBSCRIPTION_RULES,
	GCP_WORKLOAD_RULES,
	gcpBacklogGrowth,
	gcpConnectionShare,
	gcpQueryInsightsOff,
	gcpRatedShare,
	rowHealth,
	type GcpDatabaseRow,
	type GcpServiceRow,
	type GcpSubscriptionRow,
	type GcpWorkloadRow,
	type GcpWorkloadScope,
} from "../../../../components/infra/gcp/list-model"
import { formatGcpValue, GCP_INFRA_COLUMNS, type GcpColumn } from "../../../../components/infra/gcp/tabs"
import { BAR_VALUE_TONE } from "../../../../components/infra/severity-tokens"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercentColumn,
} from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { utilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"
import type { Html } from "foldkit/html"
import { meter, segmentedBar } from "../../../../ui/meter"
import { skeleton } from "../../../../ui/skeleton"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	skeletonRows,
	ROW_LINK_CLASS,
} from "../../../infra/kit/data-table"
import { type MetaItem, metaLine } from "../../../infra/kit/meta-line"
import { gcpServiceIcon } from "../service-icon"
import {
	GCP_DATABASE_BAND,
	GCP_SERVICE_BAND,
	GCP_SUBSCRIPTION_BAND,
	type GcpBandSpec,
	healthDot,
} from "./view-band"
import {
	type H,
	NAME,
	NUMBER,
	type RowsContext,
	rowSlot,
	spark,
	SUB,
	volumeCell,
	volumeHead,
	workloadHref,
	workloadRow,
} from "./view-rows"

// `GcpServicesTable`, `GcpSubscriptionsTable`, `GcpDatabasesTable` and `GcpServiceTable`.

const TABLE_MAX_HEIGHT = "640px"
const seconds = (value: number) => formatLatency(value * 1000)
const head = (h: H, label: string, width: string, align?: "right", hidden?: string) =>
	columnHead(h, { label, width, align, hidden })
const dotLane = (h: H) => h.div([h.Class("w-2 shrink-0")])

const placeItems = (
	row: { readonly region: string | undefined; readonly project: string | undefined },
	showProject: boolean,
): ReadonlyArray<MetaItem> => [row.region, showProject ? row.project : undefined]

const rowsOrEmpty = (h: H, rows: ReadonlyArray<Html>, emptyMessage: string) =>
	rows.length === 0 ? [dataTableEmpty(h, [emptyMessage])] : rows

// Services ---------------------------------------------------------------------------------------

const SERVICE_KIND = { cloudRun: "Cloud Run", cloudFunctions: "Function 1st gen" } as const

const statusMix = (h: H, row: GcpServiceRow): Html => {
	// An idle service still bills instance time; say so here, not in the sub-line, so the place fits.
	if (row.requests === 0)
		return GCP_SERVICE_RULES.inScope(row, "idle")
			? h.div(
					[
						h.Class(cn("hidden w-[170px] md:block", SUB)),
						h.Title("No requests, instance time billed"),
					],
					["idle, still billed"],
				)
			: h.div([h.Class(cn("hidden w-[170px] md:block", SUB))], ["no traffic"])
	const failedShare = row.failed / row.requests
	const clientShare = row.clientErrors / row.requests
	const rated = GCP_SERVICE_RULES.inScope(row, "serving5xx")
	const failedWord = row.service === "cloudRun" ? "5xx" : "failed"
	const label =
		row.failed > 0 && (rated || clientShare === 0)
			? {
					text: `${formatPercentColumn(failedShare)} ${failedWord}`,
					className: rated ? TONE_TEXT.crit : undefined,
				}
			: clientShare > 0
				? { text: `${formatPercentColumn(clientShare)} 4xx`, className: undefined }
				: { text: row.service === "cloudRun" ? "no errors" : "all ok", className: undefined }
	const ok = row.requests - row.clientErrors - row.failed
	return h.div(
		[h.Class("hidden w-[170px] items-center gap-2.5 md:flex")],
		[
			segmentedBar(h, {
				className: "w-[72px] shrink-0 gap-px bg-transparent",
				minVisible: 2,
				label: `ok ${ok}, 4xx ${row.clientErrors}, ${failedWord} ${row.failed}`,
				segments: [
					{ key: "ok", value: ok, className: "bg-severity-info" },
					{ key: "4xx", value: row.clientErrors, className: "bg-severity-warn" },
					{ key: "failed", value: row.failed, className: "bg-severity-error" },
				],
			}),
			h.span(
				[
					h.Class(
						cn(
							"whitespace-nowrap font-mono text-2xs tabular-nums text-muted-foreground",
							label.className,
						),
					),
				],
				[label.text],
			),
		],
	)
}

/** Below `md` the Status cell is hidden, so the idle billing note rides on the sub-line there. */
/** The idle note rides inside the last item, separator included, so hiding it at `md` leaves no stray dot. */
const serviceMeta = (h: H, row: GcpServiceRow, showProject: boolean): ReadonlyArray<MetaItem> => {
	// Only items metaLine will draw: the note joins the last shown one, never an empty slot.
	const items = [SERVICE_KIND[row.service], ...placeItems(row, showProject)].filter(
		(item): item is Html | string => item !== null && item !== undefined && item !== false && item !== "",
	)
	if (!GCP_SERVICE_RULES.inScope(row, "idle")) return items
	// Flex drops a leading space, so the note carries its own separator and gap, like metaLine's.
	const note = h.span(
		[h.Class("flex items-center gap-x-2 md:hidden")],
		[h.span([h.Class("text-foreground/20")], ["·"]), "idle, still billed"],
	)
	const last = items[items.length - 1]
	// A string keeps metaLine's 28ch cap, which it applies only to plain strings.
	const capped = typeof last === "string" ? h.span([h.Class("max-w-[28ch] truncate")], [last]) : last
	return last === undefined
		? [note]
		: [...items.slice(0, -1), h.span([h.Class("flex min-w-0 items-center gap-x-2")], [capped, note])]
}

export const servicesTable = (
	h: H,
	rows: ReadonlyArray<GcpServiceRow>,
	emptyMessage: string,
	ctx: RowsContext,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Services", maxHeight: TABLE_MAX_HEIGHT },
		[
			dotLane(h),
			head(h, "Service", NAME),
			volumeHead(h, "Requests"),
			head(h, "Status mix", "w-[170px]", undefined, "hidden md:flex"),
			head(h, "5xx", "w-[64px]", "right"),
			head(h, "Latency p95", "w-[88px]", "right"),
			head(h, "Instances", "w-[76px]", "right", "hidden lg:flex"),
			head(h, "CPU p95", "w-[64px]", "right", "hidden md:flex"),
		],
		rowsOrEmpty(
			h,
			rows.map((row) => {
				const rate = gcpRatedShare(row.failed, row.requests)
				const cpuLevel = utilizationLevel(row.cpuP95 ?? 0)
				return workloadRow(
					h,
					{
						row,
						rules: GCP_SERVICE_RULES,
						spec: GCP_SERVICE_BAND,
						meta: serviceMeta(h, row, ctx.showProject),
						timeSearch: ctx.timeSearch,
					},
					[
						volumeCell(
							h,
							ctx,
							rowSlot(`gcp-svc-${row.service}`, row.keys),
							row.requests,
							row.volume,
						),
						statusMix(h, row),
						h.div(
							[
								h.Class(
									cn(
										"w-[64px]",
										NUMBER,
										rate === undefined ? "text-muted-foreground" : errorRateClass(rate),
									),
								),
							],
							[rate === undefined ? EMPTY_VALUE : formatErrorRate(rate)],
						),
						h.div(
							[
								h.Class(
									cn(
										"w-[88px]",
										NUMBER,
										(row.latencyP95 ?? 0) >= GCP_SLOW_P95_SECONDS
											? TONE_TEXT.warn
											: "text-foreground/80",
									),
								),
							],
							[row.latencyP95 === undefined ? EMPTY_VALUE : seconds(row.latencyP95)],
						),
						h.div(
							[h.Class(cn("hidden w-[76px] text-foreground/80 lg:block", NUMBER))],
							[
								row.instances === undefined
									? EMPTY_VALUE
									: row.instances.toLocaleString(ctx.locale, { maximumFractionDigits: 1 }),
							],
						),
						h.div(
							[h.Class(cn("hidden w-[64px] md:block", NUMBER, BAR_VALUE_TONE[cpuLevel]))],
							[row.cpuP95 === undefined ? EMPTY_VALUE : formatPercentColumn(row.cpuP95)],
						),
					],
				)
			}),
			emptyMessage,
		),
	)

// Pub/Sub subscriptions --------------------------------------------------------------------------

const growthLabel = (growth: number) =>
	growth > 0 ? `+${formatNumber(growth)}` : growth < 0 ? `−${formatNumber(-growth)}` : "steady"

export const subscriptionsTable = (
	h: H,
	rows: ReadonlyArray<GcpSubscriptionRow>,
	emptyMessage: string,
	ctx: RowsContext,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Pub/Sub subscriptions", maxHeight: TABLE_MAX_HEIGHT },
		[
			dotLane(h),
			head(h, "Subscription", NAME),
			volumeHead(h, "Delivered"),
			head(h, "Backlog", "w-[200px]"),
			head(h, "Oldest unacked", "w-[104px]", "right"),
			head(h, "Push failed", "w-[84px]", "right", "hidden md:flex"),
			head(h, "Dead-lettered", "w-[96px]", "right", "hidden md:flex"),
		],
		rowsOrEmpty(
			h,
			rows.map((row) => {
				const growing = GCP_SUBSCRIPTION_RULES.inScope(row, "backlogGrowing")
				const growth = gcpBacklogGrowth(row)
				const pushRate = gcpRatedShare(row.pushFailed, row.pushRequests)
				return workloadRow(
					h,
					{
						row,
						rules: GCP_SUBSCRIPTION_RULES,
						spec: GCP_SUBSCRIPTION_BAND,
						meta: [
							row.pushRequests > 0 ? "push" : "pull",
							ctx.showProject ? row.project : undefined,
						],
						timeSearch: ctx.timeSearch,
					},
					[
						volumeCell(
							h,
							ctx,
							rowSlot("gcp-sub-delivered", row.keys),
							row.delivered,
							row.deliveredSpark,
						),
						h.div(
							[h.Class("flex w-[200px] items-center gap-3")],
							[
								h.div(
									[h.Class("flex w-[64px] shrink-0 flex-col")],
									[
										h.span(
											[
												h.Class(
													cn(
														"font-mono text-xs tabular-nums",
														growing ? TONE_TEXT.crit : "text-foreground/80",
													),
												),
											],
											[
												row.backlog === undefined
													? EMPTY_VALUE
													: formatNumber(row.backlog),
											],
										),
										...(growth === undefined
											? []
											: [h.span([h.Class(SUB)], [growthLabel(growth)])]),
									],
								),
								spark(
									h,
									ctx,
									rowSlot("gcp-sub-backlog", row.keys),
									row.backlogSpark,
									growing ? "--severity-error" : "--muted-foreground",
								),
							],
						),
						h.div(
							[
								h.Class(
									cn(
										"w-[104px]",
										NUMBER,
										(row.oldestUnackedSeconds ?? 0) >= GCP_STALE_SECONDS
											? TONE_TEXT.warn
											: "text-foreground/80",
									),
								),
							],
							[
								row.oldestUnackedSeconds === undefined
									? EMPTY_VALUE
									: seconds(row.oldestUnackedSeconds),
							],
						),
						h.div(
							[
								h.Class(
									cn(
										"hidden w-[84px] md:block",
										NUMBER,
										pushRate === undefined
											? "text-muted-foreground"
											: errorRateClass(pushRate),
									),
								),
							],
							[
								row.pushRequests === 0
									? "pull"
									: pushRate === undefined
										? EMPTY_VALUE
										: formatErrorRate(pushRate),
							],
						),
						h.div(
							[
								h.Class(
									cn(
										"hidden w-[96px] md:block",
										NUMBER,
										row.deadLettered > 0 ? TONE_TEXT.crit : "text-foreground/80",
									),
								),
							],
							[formatNumber(row.deadLettered)],
						),
					],
				)
			}),
			emptyMessage,
		),
	)

// Cloud SQL instances ----------------------------------------------------------------------------

const quotaTone = (value: number) =>
	value >= GCP_LIMIT_FRACTION ? "crit" : value >= GCP_FILLING_FRACTION ? "warn" : "neutral"

const quotaText = (value: number | undefined) => {
	const tone = quotaTone(value ?? 0)
	return tone === "neutral" ? "text-foreground/80" : TONE_TEXT[tone]
}

const quotaCell = (h: H, value: number | undefined, hidden?: string): Html =>
	h.div(
		[h.Class(cn("flex w-[72px] flex-col items-end gap-1", hidden))],
		[
			h.span(
				[h.Class(cn("font-mono text-xs tabular-nums", quotaText(value)))],
				[value === undefined ? EMPTY_VALUE : formatPercentColumn(value)],
			),
			meter(h, { value: value ?? 0, tone: quotaTone(value ?? 0), className: "w-14" }),
		],
	)

const replicasItem = (h: H, row: GcpDatabaseRow): MetaItem => {
	if (row.replicas.length === 0) {
		if (row.replicaLagSeconds === undefined) return undefined
		return h.span(row.replicaLagSeconds >= GCP_REPLICA_LAG_SECONDS ? [h.Class(TONE_TEXT.warn)] : [], [
			"replica, lag ",
			seconds(row.replicaLagSeconds),
		])
	}
	const lags = row.replicas.flatMap((replica) =>
		replica.lagSeconds === undefined ? [] : [replica.lagSeconds],
	)
	const worst = lags.length === 0 ? undefined : Math.max(...lags)
	const count = row.replicas.length === 1 ? "1 replica" : `${row.replicas.length} replicas`
	return h.span((worst ?? 0) >= GCP_REPLICA_LAG_SECONDS ? [h.Class(TONE_TEXT.warn)] : [], [
		worst === undefined
			? count
			: `${count}, lag ${row.replicas.length === 1 ? "" : "up to "}${seconds(worst)}`,
	])
}

const databaseMeta = (h: H, row: GcpDatabaseRow, showProject: boolean): ReadonlyArray<MetaItem> => [
	gcpSqlEngine(row.engine ?? null),
	row.instance === undefined ? undefined : gcpSqlSize(row.instance),
	replicasItem(h, row),
	...placeItems(row, showProject),
]

const isMysql = (row: GcpDatabaseRow) => row.instance?.databaseVersion?.startsWith("MYSQL") === true

const queriesCell = (h: H, row: GcpDatabaseRow, ctx: RowsContext): Html =>
	row.queries !== undefined
		? h.div(
				[h.Class("hidden md:block")],
				[volumeCell(h, ctx, rowSlot("gcp-sql-queries", row.keys), row.queries, row.queriesSpark)],
			)
		: h.div(
				[h.Class("hidden w-[180px] items-center gap-3 md:flex")],
				[
					h.span(
						[h.Class("w-[56px] shrink-0 font-mono text-xs text-muted-foreground")],
						[EMPTY_VALUE],
					),
					...(gcpQueryInsightsOff(row) ? [h.span([h.Class(SUB)], ["Insights off"])] : []),
				],
			)

const queryP95Cell = (h: H, row: GcpDatabaseRow): Html => {
	const slow = (row.queryP95 ?? 0) >= GCP_SLOW_P95_SECONDS
	return h.div(
		[h.Class("flex w-[80px] flex-col items-end")],
		[
			h.span(
				[h.Class(cn(NUMBER, slow ? TONE_TEXT.warn : "text-foreground/80"))],
				[row.queryP95 === undefined ? EMPTY_VALUE : seconds(row.queryP95)],
			),
			...(isMysql(row) || row.slowQueries > 0
				? [
						h.span(
							[h.Class(cn(SUB, row.slowQueries > 0 && TONE_TEXT.warn))],
							[formatNumber(row.slowQueries), " slow"],
						),
					]
				: []),
		],
	)
}

const connectionsCell = (h: H, row: GcpDatabaseRow, locale: string): Html => {
	const max = row.instance?.maxConnections ?? null
	const share = gcpConnectionShare(row)
	const idle = Math.round(row.idleInTransaction ?? 0)
	const count = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 0 })
	return h.div(
		[h.Class("flex w-[150px] flex-col items-end")],
		[
			h.span(
				[h.Class(cn(NUMBER, quotaText(share)))],
				[
					row.connections === undefined
						? EMPTY_VALUE
						: max === null
							? count(row.connections)
							: `${count(row.connections)} / ${count(max)}`,
				],
			),
			...(idle > 0
				? [h.span([h.Class(cn(SUB, TONE_TEXT.warn))], [formatNumber(idle), " idle in transaction"])]
				: row.instance !== undefined && max === null
					? [h.span([h.Class(SUB)], ["no max reported"])]
					: []),
		],
	)
}

const databasesFooter = (h: H, rows: ReadonlyArray<GcpDatabaseRow>): ReadonlyArray<Html> => {
	const replicas = rows.flatMap((row) => row.replicas)
	const off = rows.filter(gcpQueryInsightsOff)
	if (replicas.length === 0 && off.length === 0) return []
	return [
		h.div(
			[
				h.Class(
					"flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2.5 font-mono text-2xs text-muted-foreground",
				),
			],
			[
				h.span(
					[],
					replicas.length === 0
						? []
						: [
								[
									"Read replicas fold into their primary",
									...replicas.map((replica) =>
										replica.lagSeconds === undefined
											? replica.name
											: `${replica.name} lags ${seconds(replica.lagSeconds)}`,
									),
								].join(" · "),
							],
				),
				h.span(
					[h.Class("flex flex-wrap gap-x-4")],
					off.map((row) =>
						h.a(
							[
								h.Class("text-primary hover:text-primary/80"),
								h.Href(gcpQueryInsightsConsoleUrl(row.project ?? "", row.name)),
								h.Rel("noreferrer"),
								h.Target("_blank"),
							],
							["Enable Query Insights on ", row.name],
						),
					),
				),
			],
		),
	]
}

export const databasesTable = (
	h: H,
	rows: ReadonlyArray<GcpDatabaseRow>,
	emptyMessage: string,
	ctx: RowsContext,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Cloud SQL instances", maxHeight: TABLE_MAX_HEIGHT },
		[
			dotLane(h),
			head(h, "Instance", NAME),
			volumeHead(h, "Queries", "hidden md:flex"),
			head(h, "Query p95", "w-[80px]", "right"),
			head(h, "CPU", "w-[72px]", "right"),
			head(h, "Memory", "w-[72px]", "right", "hidden md:flex"),
			head(h, "Disk", "w-[72px]", "right"),
			head(h, "Connections", "w-[150px]", "right"),
		],
		[
			...rowsOrEmpty(
				h,
				rows.map((row) =>
					workloadRow(
						h,
						{
							row,
							rules: GCP_DATABASE_RULES,
							spec: GCP_DATABASE_BAND,
							meta: databaseMeta(h, row, ctx.showProject),
							timeSearch: ctx.timeSearch,
						},
						[
							queriesCell(h, row, ctx),
							queryP95Cell(h, row),
							quotaCell(h, row.cpu),
							quotaCell(h, row.memory, "hidden md:flex"),
							quotaCell(h, row.disk),
							connectionsCell(h, row, ctx.locale),
						],
					),
				),
				emptyMessage,
			),
			...databasesFooter(h, rows),
		],
	)

// The other services (GKE, Compute Engine, Load Balancing) ---------------------------------------

const GENERIC_NAME = "w-0 flex-1 min-w-[240px]"
const VALUE_WIDTH = "w-[104px]"

const genericHead = (h: H, service: GcpInfraServiceId): ReadonlyArray<Html> => [
	dotLane(h),
	head(h, GCP_INFRA_SERVICES[service].identity[0]?.[0] ?? "", GENERIC_NAME),
	...GCP_INFRA_COLUMNS[service].map((column) => head(h, column.label, VALUE_WIDTH, "right")),
]

/** `GcpServiceTableLoading`. */
export const serviceTableLoading = (h: H, service: GcpInfraServiceId): Html =>
	dataTable(
		h,
		{ ariaLabel: GCP_INFRA_SERVICES[service].title },
		genericHead(h, service),
		skeletonRows(h, 5, () => [
			dotLane(h),
			h.div(
				[h.Class(cn(GENERIC_NAME, "flex items-center gap-3"))],
				[
					skeleton(h, "size-7 shrink-0 rounded-md"),
					h.div([], [skeleton(h, "h-4 w-40"), skeleton(h, "mt-1.5 h-3 w-28")]),
				],
			),
			...GCP_INFRA_COLUMNS[service].map(() => skeleton(h, cn("h-3", VALUE_WIDTH))),
		]),
	)

export const valueClass = (spec: GcpColumn, value: number | undefined): string => {
	if (value !== undefined && spec.format === "errorRate") return errorRateClass(value)
	if (value !== undefined && spec.format === "percent" && utilizationLevel(value) !== "ok") {
		return BAR_VALUE_TONE[utilizationLevel(value)]
	}
	return "text-foreground/80"
}

/** `GcpServiceTable`: a service without a list of its own, its curated columns. */
export const serviceTable = (
	h: H,
	service: GcpInfraServiceId,
	rows: ReadonlyArray<GcpWorkloadRow>,
	spec: GcpBandSpec<GcpWorkloadScope>,
	emptyMessage: string,
	ctx: RowsContext,
): Html => {
	const { title, identity } = GCP_INFRA_SERVICES[service]
	const columns = GCP_INFRA_COLUMNS[service]
	return dataTable(
		h,
		{ ariaLabel: title },
		genericHead(h, service),
		rowsOrEmpty(
			h,
			rows.map((row) => {
				const line = metaLine(h, row.keys.slice(1), {
					title: identity
						.slice(1)
						.map(([label], index) => `${label}: ${row.keys[index + 1] ?? ""}`)
						.join(" · "),
				})
				return h.a(
					[h.Class(ROW_LINK_CLASS), h.Href(workloadHref(service, row.keys, ctx.timeSearch))],
					[
						healthDot(h, spec, rowHealth(GCP_WORKLOAD_RULES, row)),
						h.div(
							[h.Class(cn(GENERIC_NAME, "flex items-center gap-3"))],
							[
								gcpServiceIcon(h, { service }),
								h.div(
									[h.Class("min-w-0 flex-1")],
									[
										h.div(
											[
												h.Class(
													"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
												),
											],
											[row.name],
										),
										...(line === null ? [] : [line]),
									],
								),
							],
						),
						...columns.map((column, index) =>
							h.div(
								[
									h.Class(
										cn(
											"text-right font-mono text-xs tabular-nums",
											VALUE_WIDTH,
											valueClass(column, row.workload.values[index]),
										),
									),
								],
								[formatGcpValue(column.format, row.workload.values[index])],
							),
						),
					],
				)
			}),
			emptyMessage,
		),
	)
}
