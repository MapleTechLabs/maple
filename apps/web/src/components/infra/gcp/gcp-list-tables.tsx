// The Google Cloud lists' tables: services, Pub/Sub subscriptions, Cloud SQL instances. Rows
// arrive ordered (problems first); a row opens the workload's page.

import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { PlotSparkline } from "@maple/ui/components/plot"
import { Meter, SegmentedBar } from "@maple/ui/components/ui/meter"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { utilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable, ROW_LINK_CLASS } from "@/components/common/data-table"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { MetaLine, type MetaItem } from "../primitives/meta-line"
import { BAR_VALUE_TONE } from "../severity-tokens"
import {
	GCP_DATABASE_BAND,
	GCP_SERVICE_BAND,
	GCP_SUBSCRIPTION_BAND,
	GcpHealthDot,
	type GcpBandSpec,
} from "./gcp-bands"
import {
	GCP_DATABASE_RULES,
	GCP_FILLING_FRACTION,
	GCP_LIMIT_FRACTION,
	GCP_REPLICA_LAG_SECONDS,
	GCP_SERVICE_RULES,
	GCP_SLOW_P95_SECONDS,
	GCP_STALE_SECONDS,
	GCP_SUBSCRIPTION_RULES,
	gcpBacklogGrowth,
	gcpConnectionShare,
	gcpQueryInsightsOff,
	gcpRatedShare,
	rowHealth,
	type GcpDatabaseRow,
	type GcpServiceRow,
	type GcpSubscriptionRow,
	type RowRules,
} from "./list-model"
import { gcpQueryInsightsConsoleUrl, gcpSqlEngine, gcpSqlSize } from "./cloud-sql-signals"
import { GcpServiceIcon } from "./gcp-service-icon"
import { gcpWorkloadId, gcpWorkloadSearch } from "./tabs"

const TABLE_MAX_HEIGHT = 640
const NAME = "w-0 min-w-[220px] flex-1"
const NUMBER = "text-right font-mono text-xs tabular-nums"
const SUB = "font-mono text-3xs text-muted-foreground"

const seconds = (value: number) => formatLatency(value * 1000)

/** Where a workload runs, in its row's sub-line: the project only while the list spans several. */
const placeItems = (
	row: { readonly region: string | undefined; readonly project: string | undefined },
	showProject: boolean,
): ReadonlyArray<MetaItem> => [row.region, showProject ? row.project : undefined]

interface RowsProps<R> {
	rows: ReadonlyArray<R>
	/** Says so when the search or a scope hid every row. */
	emptyMessage: string
	timeSearch: TimeRangeSearch
	showProject: boolean
	waiting?: boolean
}

/** A row of any list: the health dot, the service's glyph, the name with its sub-line, then the view's cells. */
function WorkloadRow<R extends GcpServiceRow | GcpSubscriptionRow | GcpDatabaseRow, S extends string>({
	row,
	rules,
	spec,
	meta,
	timeSearch,
	children,
}: {
	row: R
	rules: RowRules<R, S>
	spec: GcpBandSpec<S>
	meta: ReadonlyArray<MetaItem>
	timeSearch: TimeRangeSearch
	children: ReactNode
}) {
	return (
		<Link
			to="/infra/gcp/$service/$name"
			params={{ service: row.service, name: row.keys[0] }}
			search={{ ...timeSearch, ...gcpWorkloadSearch(row.service, row.keys) }}
			className={ROW_LINK_CLASS}
		>
			<GcpHealthDot spec={spec} health={rowHealth(rules, row)} />
			<div className={cn(NAME, "flex items-center gap-3")}>
				<GcpServiceIcon
					service={row.service}
					databaseVersion={"engine" in row ? row.engine : undefined}
				/>
				<div className="min-w-0 flex-1 space-y-0.5">
					<div
						className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary"
						title={row.name}
					>
						{row.name}
					</div>
					<MetaLine items={meta} />
				</div>
			</div>
			{children}
		</Link>
	)
}

function Spark({ values, color }: { values: ReadonlyArray<number> | undefined; color: string }) {
	if (values === undefined || values.length < 2) return <div className="h-5 min-w-0 flex-1" />
	return (
		<div className="h-5 min-w-0 flex-1">
			<PlotSparkline values={values} color={color} curve="monotone" className="h-full w-full" />
		</div>
	)
}

/** A count and its sparkline, in one column. */
function VolumeCell({
	value,
	spark,
	color = "--chart-2",
}: {
	value: number
	spark: ReadonlyArray<number> | undefined
	color?: string
}) {
	return (
		<div className="flex w-[180px] items-center gap-3">
			<span className="w-[56px] shrink-0 font-mono text-xs tabular-nums text-foreground/80">
				{formatNumber(value)}
			</span>
			<Spark values={spark} color={color} />
		</div>
	)
}

// Services ---------------------------------------------------------------------------------------

function ServiceColumns() {
	return (
		<>
			<div className="w-2 shrink-0" />
			<ColumnHead label="Service" width={NAME} />
			<ColumnHead label="Requests" width="w-[180px]" />
			<ColumnHead label="Status mix" width="w-[170px]" hidden="hidden md:flex" />
			<ColumnHead label="5xx" align="right" width="w-[64px]" />
			<ColumnHead label="Latency p95" align="right" width="w-[88px]" />
			<ColumnHead label="Instances" align="right" width="w-[76px]" hidden="hidden lg:flex" />
			<ColumnHead label="CPU p95" align="right" width="w-[64px]" hidden="hidden md:flex" />
		</>
	)
}

const SERVICE_KIND = { cloudRun: "Cloud Run", cloudFunctions: "Function 1st gen" } as const

function serviceMeta(row: GcpServiceRow, showProject: boolean): ReadonlyArray<MetaItem> {
	const idle = GCP_SERVICE_RULES.inScope(row, "idle")
	return [
		SERVICE_KIND[row.service],
		...placeItems(row, showProject),
		idle ? (
			<span key="idle" className={TONE_TEXT.warn}>
				no requests · instance time billed
			</span>
		) : undefined,
	]
}

/** The share of requests that ended well, in 4xx, and failed; a function knows only ok and failed. */
function StatusMix({ row }: { row: GcpServiceRow }) {
	if (row.requests === 0) {
		return <div className={cn("hidden w-[170px] md:block", SUB)}>no traffic</div>
	}
	const failedShare = row.failed / row.requests
	const clientShare = row.clientErrors / row.requests
	const rated = GCP_SERVICE_RULES.inScope(row, "serving5xx")
	const failedWord = row.service === "cloudRun" ? "5xx" : "failed"
	const label =
		row.failed > 0 && (rated || clientShare === 0)
			? {
					text: `${formatPercent(failedShare)} ${failedWord}`,
					className: rated ? TONE_TEXT.crit : undefined,
				}
			: clientShare > 0
				? { text: `${formatPercent(clientShare)} 4xx`, className: undefined }
				: { text: row.service === "cloudRun" ? "no errors" : "all ok", className: undefined }
	return (
		<div className="hidden w-[170px] items-center gap-2.5 md:flex">
			<SegmentedBar
				className="w-[72px] shrink-0 gap-px bg-transparent"
				minVisible={2}
				label={`ok ${row.requests - row.clientErrors - row.failed}, 4xx ${row.clientErrors}, ${failedWord} ${row.failed}`}
				segments={[
					{
						key: "ok",
						value: row.requests - row.clientErrors - row.failed,
						className: "bg-severity-info",
					},
					{ key: "4xx", value: row.clientErrors, className: "bg-severity-warn" },
					{ key: "failed", value: row.failed, className: "bg-severity-error" },
				]}
			/>
			<span
				className={cn(
					"whitespace-nowrap font-mono text-2xs tabular-nums text-muted-foreground",
					label.className,
				)}
			>
				{label.text}
			</span>
		</div>
	)
}

export function GcpServicesTable({
	rows,
	emptyMessage,
	timeSearch,
	showProject,
	waiting,
}: RowsProps<GcpServiceRow>) {
	return (
		<DataTable.Root ariaLabel="Services" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>
				<ServiceColumns />
			</DataTable.Head>
			{rows.length === 0 ? <DataTable.Empty>{emptyMessage}</DataTable.Empty> : null}
			{rows.map((row) => {
				const rate = gcpRatedShare(row.failed, row.requests)
				const cpuLevel = utilizationLevel(row.cpuP95 ?? 0)
				return (
					<WorkloadRow
						key={`${row.service}:${gcpWorkloadId(row.keys)}`}
						row={row}
						rules={GCP_SERVICE_RULES}
						spec={GCP_SERVICE_BAND}
						meta={serviceMeta(row, showProject)}
						timeSearch={timeSearch}
					>
						<VolumeCell value={row.requests} spark={row.volume} />
						<StatusMix row={row} />
						<div
							className={cn(
								"w-[64px]",
								NUMBER,
								rate === undefined ? "text-muted-foreground" : errorRateClass(rate),
							)}
						>
							{rate === undefined ? EMPTY_VALUE : formatErrorRate(rate)}
						</div>
						<div
							className={cn(
								"w-[88px]",
								NUMBER,
								(row.latencyP95 ?? 0) >= GCP_SLOW_P95_SECONDS
									? TONE_TEXT.warn
									: "text-foreground/80",
							)}
						>
							{row.latencyP95 === undefined ? EMPTY_VALUE : seconds(row.latencyP95)}
						</div>
						<div className={cn("hidden w-[76px] text-foreground/80 lg:block", NUMBER)}>
							{row.instances === undefined
								? EMPTY_VALUE
								: row.instances.toLocaleString(undefined, { maximumFractionDigits: 1 })}
						</div>
						<div className={cn("hidden w-[64px] md:block", NUMBER, BAR_VALUE_TONE[cpuLevel])}>
							{row.cpuP95 === undefined ? EMPTY_VALUE : formatPercent(row.cpuP95)}
						</div>
					</WorkloadRow>
				)
			})}
		</DataTable.Root>
	)
}

// Pub/Sub subscriptions --------------------------------------------------------------------------

function SubscriptionColumns() {
	return (
		<>
			<div className="w-2 shrink-0" />
			<ColumnHead label="Subscription" width={NAME} />
			<ColumnHead label="Delivered" width="w-[180px]" />
			<ColumnHead label="Backlog" width="w-[200px]" />
			<ColumnHead label="Oldest unacked" align="right" width="w-[104px]" />
			<ColumnHead label="Push failed" align="right" width="w-[84px]" hidden="hidden md:flex" />
			<ColumnHead label="Dead-lettered" align="right" width="w-[96px]" hidden="hidden md:flex" />
		</>
	)
}

/** "+46K", "−120", or "steady" when the backlog ended where it began. */
const growthLabel = (growth: number) =>
	growth > 0 ? `+${formatNumber(growth)}` : growth < 0 ? `−${formatNumber(-growth)}` : "steady"

export function GcpSubscriptionsTable({
	rows,
	emptyMessage,
	timeSearch,
	showProject,
	waiting,
}: RowsProps<GcpSubscriptionRow>) {
	return (
		<DataTable.Root ariaLabel="Pub/Sub subscriptions" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>
				<SubscriptionColumns />
			</DataTable.Head>
			{rows.length === 0 ? <DataTable.Empty>{emptyMessage}</DataTable.Empty> : null}
			{rows.map((row) => {
				const growing = GCP_SUBSCRIPTION_RULES.inScope(row, "backlogGrowing")
				const growth = gcpBacklogGrowth(row)
				const pushRate = gcpRatedShare(row.pushFailed, row.pushRequests)
				return (
					<WorkloadRow
						key={gcpWorkloadId(row.keys)}
						row={row}
						rules={GCP_SUBSCRIPTION_RULES}
						spec={GCP_SUBSCRIPTION_BAND}
						meta={[row.pushRequests > 0 ? "push" : "pull", showProject ? row.project : undefined]}
						timeSearch={timeSearch}
					>
						<VolumeCell value={row.delivered} spark={row.deliveredSpark} />
						<div className="flex w-[200px] items-center gap-3">
							<div className="flex w-[64px] shrink-0 flex-col">
								<span
									className={cn(
										"font-mono text-xs tabular-nums",
										growing ? TONE_TEXT.crit : "text-foreground/80",
									)}
								>
									{row.backlog === undefined ? EMPTY_VALUE : formatNumber(row.backlog)}
								</span>
								{growth === undefined ? null : (
									<span className={SUB}>{growthLabel(growth)}</span>
								)}
							</div>
							<Spark
								values={row.backlogSpark}
								color={growing ? "--severity-error" : "--muted-foreground"}
							/>
						</div>
						<div
							className={cn(
								"w-[104px]",
								NUMBER,
								(row.oldestUnackedSeconds ?? 0) >= GCP_STALE_SECONDS
									? TONE_TEXT.warn
									: "text-foreground/80",
							)}
						>
							{row.oldestUnackedSeconds === undefined
								? EMPTY_VALUE
								: seconds(row.oldestUnackedSeconds)}
						</div>
						<div
							className={cn(
								"hidden w-[84px] md:block",
								NUMBER,
								pushRate === undefined ? "text-muted-foreground" : errorRateClass(pushRate),
							)}
						>
							{row.pushRequests === 0
								? "pull"
								: pushRate === undefined
									? EMPTY_VALUE
									: formatErrorRate(pushRate)}
						</div>
						<div
							className={cn(
								"hidden w-[96px] md:block",
								NUMBER,
								row.deadLettered > 0 ? TONE_TEXT.crit : "text-foreground/80",
							)}
						>
							{formatNumber(row.deadLettered)}
						</div>
					</WorkloadRow>
				)
			})}
		</DataTable.Root>
	)
}

// Cloud SQL instances ----------------------------------------------------------------------------

function DatabaseColumns() {
	return (
		<>
			<div className="w-2 shrink-0" />
			<ColumnHead label="Instance" width={NAME} />
			<ColumnHead label="Queries" width="w-[180px]" hidden="hidden md:flex" />
			<ColumnHead label="Query p95" align="right" width="w-[80px]" />
			<ColumnHead label="CPU" align="right" width="w-[72px]" />
			<ColumnHead label="Memory" align="right" width="w-[72px]" hidden="hidden md:flex" />
			<ColumnHead label="Disk" align="right" width="w-[72px]" />
			<ColumnHead label="Connections" align="right" width="w-[150px]" />
		</>
	)
}

/** A share of a quota, Cloud SQL's way: filling up from 80%, at the limit from 90%. */
const quotaTone = (value: number) =>
	value >= GCP_LIMIT_FRACTION ? "crit" : value >= GCP_FILLING_FRACTION ? "warn" : "neutral"

const quotaText = (value: number | undefined) => {
	const tone = quotaTone(value ?? 0)
	return tone === "neutral" ? "text-foreground/80" : TONE_TEXT[tone]
}

function QuotaCell({ value, hidden }: { value: number | undefined; hidden?: string }) {
	return (
		<div className={cn("flex w-[72px] flex-col items-end gap-1", hidden)}>
			<span className={cn("font-mono text-xs tabular-nums", quotaText(value))}>
				{value === undefined ? EMPTY_VALUE : formatPercent(value)}
			</span>
			<Meter value={value ?? 0} tone={quotaTone(value ?? 0)} className="w-14" />
		</div>
	)
}

/** "1 replica, lag 4s", or the worst lag of several. */
function replicasItem(row: GcpDatabaseRow): MetaItem {
	if (row.replicas.length === 0) {
		if (row.replicaLagSeconds === undefined) return undefined
		return (
			<span
				key="lag"
				className={row.replicaLagSeconds >= GCP_REPLICA_LAG_SECONDS ? TONE_TEXT.warn : undefined}
			>
				replica, lag {seconds(row.replicaLagSeconds)}
			</span>
		)
	}
	const lags = row.replicas.flatMap((replica) =>
		replica.lagSeconds === undefined ? [] : [replica.lagSeconds],
	)
	const worst = lags.length === 0 ? undefined : Math.max(...lags)
	const count = row.replicas.length === 1 ? "1 replica" : `${row.replicas.length} replicas`
	return (
		<span key="replicas" className={(worst ?? 0) >= GCP_REPLICA_LAG_SECONDS ? TONE_TEXT.warn : undefined}>
			{worst === undefined
				? count
				: `${count}, lag ${row.replicas.length === 1 ? "" : "up to "}${seconds(worst)}`}
		</span>
	)
}

function databaseMeta(row: GcpDatabaseRow, showProject: boolean): ReadonlyArray<MetaItem> {
	return [
		gcpSqlEngine(row.engine ?? null),
		row.instance === undefined ? undefined : gcpSqlSize(row.instance),
		replicasItem(row),
		...placeItems(row, showProject),
	]
}

const isMysql = (row: GcpDatabaseRow) => row.instance?.databaseVersion?.startsWith("MYSQL") === true

/** Query Insights' count and its sparkline, or why there is none. */
function QueriesCell({ row }: { row: GcpDatabaseRow }) {
	if (row.queries !== undefined) {
		return (
			<div className="hidden md:block">
				<VolumeCell value={row.queries} spark={row.queriesSpark} />
			</div>
		)
	}
	return (
		<div className="hidden w-[180px] items-center gap-3 md:flex">
			<span className="w-[56px] shrink-0 font-mono text-xs text-muted-foreground">{EMPTY_VALUE}</span>
			{gcpQueryInsightsOff(row) ? <span className={SUB}>Insights off</span> : null}
		</div>
	)
}

function QueryP95Cell({ row }: { row: GcpDatabaseRow }) {
	const slow = (row.queryP95 ?? 0) >= GCP_SLOW_P95_SECONDS
	return (
		<div className="flex w-[80px] flex-col items-end">
			<span className={cn(NUMBER, slow ? TONE_TEXT.warn : "text-foreground/80")}>
				{row.queryP95 === undefined ? EMPTY_VALUE : seconds(row.queryP95)}
			</span>
			{/* MySQL has no latency metric, only a count of slow queries. */}
			{isMysql(row) || row.slowQueries > 0 ? (
				<span className={cn(SUB, row.slowQueries > 0 && TONE_TEXT.warn)}>
					{formatNumber(row.slowQueries)} slow
				</span>
			) : null}
		</div>
	)
}

/** "97 / 100" against `max_connections`, and the connections a leaking pool holds idle. */
function ConnectionsCell({ row }: { row: GcpDatabaseRow }) {
	const max = row.instance?.maxConnections ?? null
	const share = gcpConnectionShare(row)
	const idle = Math.round(row.idleInTransaction ?? 0)
	const count = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 })
	return (
		<div className="flex w-[150px] flex-col items-end">
			<span className={cn(NUMBER, quotaText(share))}>
				{row.connections === undefined
					? EMPTY_VALUE
					: max === null
						? count(row.connections)
						: `${count(row.connections)} / ${count(max)}`}
			</span>
			{idle > 0 ? (
				<span className={cn(SUB, TONE_TEXT.warn)}>{formatNumber(idle)} idle in transaction</span>
			) : row.instance !== undefined && max === null ? (
				<span className={SUB}>no max reported</span>
			) : null}
		</div>
	)
}

/** What the rows leave out: the replicas folded into them, and the instances Query Insights is off on. */
function DatabasesFooter({ rows }: { rows: ReadonlyArray<GcpDatabaseRow> }) {
	const replicas = rows.flatMap((row) => row.replicas)
	const off = rows.filter(gcpQueryInsightsOff)
	if (replicas.length === 0 && off.length === 0) return null
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2.5 font-mono text-2xs text-muted-foreground">
			<span>
				{replicas.length === 0
					? null
					: [
							"Read replicas fold into their primary",
							...replicas.map((replica) =>
								replica.lagSeconds === undefined
									? replica.name
									: `${replica.name} lags ${seconds(replica.lagSeconds)}`,
							),
						].join(" · ")}
			</span>
			<span className="flex flex-wrap gap-x-4">
				{off.map((row) => (
					<a
						key={gcpWorkloadId(row.keys)}
						href={gcpQueryInsightsConsoleUrl(row.project ?? "", row.name)}
						target="_blank"
						rel="noreferrer"
						className="text-primary hover:text-primary/80"
					>
						Enable Query Insights on {row.name}
					</a>
				))}
			</span>
		</div>
	)
}

export function GcpDatabasesTable({
	rows,
	emptyMessage,
	timeSearch,
	showProject,
	waiting,
}: RowsProps<GcpDatabaseRow>) {
	return (
		<DataTable.Root ariaLabel="Cloud SQL instances" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>
				<DatabaseColumns />
			</DataTable.Head>
			{rows.length === 0 ? <DataTable.Empty>{emptyMessage}</DataTable.Empty> : null}
			{rows.map((row) => (
				<WorkloadRow
					key={gcpWorkloadId(row.keys)}
					row={row}
					rules={GCP_DATABASE_RULES}
					spec={GCP_DATABASE_BAND}
					meta={databaseMeta(row, showProject)}
					timeSearch={timeSearch}
				>
					<QueriesCell row={row} />
					<QueryP95Cell row={row} />
					<QuotaCell value={row.cpu} />
					<QuotaCell value={row.memory} hidden="hidden md:flex" />
					<QuotaCell value={row.disk} />
					<ConnectionsCell row={row} />
				</WorkloadRow>
			))}
			<DatabasesFooter rows={rows} />
		</DataTable.Root>
	)
}
