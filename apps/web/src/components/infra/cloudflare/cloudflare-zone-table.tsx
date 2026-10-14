import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { SegmentedBar } from "@maple/ui/components/ui/meter"
import { PlotSparkline } from "@maple/ui/components/plot"
import { cn } from "@maple/ui/lib/utils"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import {
	ColumnHead,
	DataTable,
	type SortControls,
	ROW_LINK_CLASS,
	useTableSort,
} from "@/components/common/data-table"
import { MetaLine } from "../primitives/meta-line"
import { CLIENT_ERROR_NOTABLE, MIN_RATED_REQUESTS } from "./list-model"

type SortKey =
	| "zoneName"
	| "requests"
	| "errorRate"
	| "clientErrorRate"
	| "cacheHitRate"
	| "bytes"
	| "ttfbP99Ms"

// The server caps the list at 500 zones, so the row area scrolls rather than growing the page.
const TABLE_MAX_HEIGHT = 560

interface CloudflareZoneTableProps {
	zones: ReadonlyArray<CloudflareZoneRow>
	/** Requests per bucket, keyed by service name, for the row sparkline. */
	sparks?: ReadonlyMap<string, ReadonlyArray<number>>
	/** Account name per zone service; the column only renders when it is passed. */
	accounts?: ReadonlyMap<string, string>
	waiting?: boolean
	/** Overrides the "no traffic" empty when the list is empty because of a filter, not the window. */
	emptyMessage?: string
}

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function ZoneColumns({
	sort,
	showAccount,
	showLatency,
}: {
	sort?: SortControls<SortKey>
	showAccount: boolean
	showLatency: boolean
}) {
	return (
		<>
			<ColumnHead<SortKey> label="Zone" sortKey="zoneName" {...sort} width="w-0 flex-1 min-w-[200px]" />
			{showAccount ? <ColumnHead label="Account" width="w-[120px]" hidden="hidden lg:flex" /> : null}
			<ColumnHead<SortKey> label="Requests" sortKey="requests" {...sort} width="w-[170px]" />
			<ColumnHead<SortKey>
				label="Status mix"
				sortKey="clientErrorRate"
				{...sort}
				width="w-[170px]"
				hidden="hidden md:flex"
			/>
			<ColumnHead<SortKey> label="5xx" sortKey="errorRate" {...sort} align="right" width="w-[70px]" />
			<ColumnHead<SortKey>
				label="Cache hit"
				sortKey="cacheHitRate"
				{...sort}
				align="right"
				width="w-[120px]"
				hidden="hidden lg:flex"
			/>
			{showLatency ? (
				<ColumnHead<SortKey>
					label="TTFB p99"
					sortKey="ttfbP99Ms"
					{...sort}
					align="right"
					width="w-[80px]"
					hidden="hidden lg:flex"
				/>
			) : null}
			<ColumnHead<SortKey>
				label="Bandwidth"
				sortKey="bytes"
				{...sort}
				align="right"
				width="w-[80px]"
				hidden="hidden md:flex"
			/>
		</>
	)
}

export function CloudflareZoneTableLoading() {
	return (
		<DataTable.Root ariaLabel="Zones">
			<DataTable.Head>
				<ZoneColumns showAccount={false} showLatency={false} />
			</DataTable.Head>
			<DataTable.SkeletonRows count={4}>
				<div className="w-0 min-w-[200px] flex-1 space-y-1.5">
					<Skeleton className="h-3.5 w-40" />
					<Skeleton className="h-2.5 w-24" />
				</div>
				<Skeleton className="h-4 w-[170px]" />
				<Skeleton className="hidden h-1.5 w-[170px] md:block" />
				<Skeleton className="h-3 w-[70px]" />
				<Skeleton className="hidden h-3 w-[120px] lg:block" />
				<Skeleton className="hidden h-3 w-[80px] md:block" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function CloudflareZoneTable({
	zones,
	sparks,
	accounts,
	waiting,
	emptyMessage,
}: CloudflareZoneTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareZoneRow, SortKey>(zones, {
		initialKey: "requests",
		stringKeys: ["zoneName"],
	})
	const showAccount = accounts !== undefined
	// Latency quantiles are plan-gated; four always-empty columns were most of the old table.
	const showLatency = zones.some((zone) => zone.ttfbP99Ms > 0)

	return (
		<DataTable.Root ariaLabel="Cloudflare zones" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>
				<ZoneColumns
					sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }}
					showAccount={showAccount}
					showLatency={showLatency}
				/>
			</DataTable.Head>
			{sorted.length === 0 && (
				<DataTable.Empty>{emptyMessage ?? "No zone traffic in the selected window."}</DataTable.Empty>
			)}

			{sorted.map((zone) => {
				const rated = zone.requests >= MIN_RATED_REQUESTS
				return (
					<Link
						key={zone.serviceName}
						to="/infra/cloudflare/$zoneName"
						params={{ zoneName: zone.zoneName }}
						className={ROW_LINK_CLASS}
					>
						<div className="w-0 min-w-[200px] flex-1 space-y-0.5">
							<div
								className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary"
								title={zone.zoneName}
							>
								{zone.zoneName}
							</div>
							<MetaLine
								items={[
									zone.visits > 0 ? `${formatNumber(zone.visits)} visits` : "",
									rated ? "" : "too few requests to rate",
								]}
							/>
						</div>
						{showAccount ? (
							<div className="hidden w-[120px] truncate font-mono text-2xs text-muted-foreground lg:block">
								{accounts.get(zone.serviceName) ?? EMPTY_VALUE}
							</div>
						) : null}
						<div className="flex w-[170px] items-center gap-3">
							<span className="w-[56px] shrink-0 font-mono text-xs tabular-nums text-foreground/80">
								{formatNumber(zone.requests)}
							</span>
							<RequestSpark values={sparks?.get(zone.serviceName)} />
						</div>
						<StatusMix zone={zone} rated={rated} />
						<div
							className={cn(
								"w-[70px] text-right font-mono text-xs tabular-nums",
								rated ? errorRateClass(zone.errorRate) : "text-muted-foreground",
							)}
						>
							{rated ? formatErrorRate(zone.errorRate) : EMPTY_VALUE}
						</div>
						<div className="hidden w-[120px] flex-col items-end gap-0.5 lg:flex">
							<span className="font-mono text-xs tabular-nums text-foreground/80">
								{zone.cacheHitRate === null ? EMPTY_VALUE : formatPercent(zone.cacheHitRate)}
							</span>
							<span className="font-mono text-3xs text-muted-foreground">
								{zone.cacheHitRate === null
									? "nothing cacheable"
									: `of ${formatPercent(zone.requests > 0 ? zone.cacheableRequests / zone.requests : 0)} cacheable`}
							</span>
						</div>
						{showLatency ? (
							<div className="hidden w-[80px] text-right font-mono text-xs tabular-nums text-foreground/80 lg:block">
								{zone.ttfbP99Ms > 0 ? formatLatency(zone.ttfbP99Ms) : EMPTY_VALUE}
							</div>
						) : null}
						<div className="hidden w-[80px] text-right font-mono text-xs tabular-nums text-foreground/80 md:block">
							{formatBytes(zone.bytes)}
						</div>
					</Link>
				)
			})}
		</DataTable.Root>
	)
}

function RequestSpark({ values }: { values: ReadonlyArray<number> | undefined }) {
	if (values === undefined || values.length < 2) return <div className="h-5 min-w-0 flex-1" />
	return (
		<div className="h-5 min-w-0 flex-1">
			<PlotSparkline values={values} color="--chart-2" curve="monotone" className="h-full w-full" />
		</div>
	)
}

/** One bar per zone: 2xx/3xx/4xx/5xx shares, labelled with whichever error class dominates. */
function StatusMix({ zone, rated }: { zone: CloudflareZoneRow; rated: boolean }) {
	const label =
		zone.errorRate >= 0.01
			? { text: `${formatPercent(zone.errorRate)} 5xx`, className: "text-severity-error" }
			: {
					text: `${formatPercent(zone.clientErrorRate)} 4xx`,
					className:
						zone.clientErrorRate >= CLIENT_ERROR_NOTABLE
							? "text-severity-warn"
							: "text-muted-foreground",
				}
	return (
		<div className="hidden w-[170px] items-center gap-2.5 md:flex">
			<SegmentedBar
				className="w-[100px] shrink-0 gap-px bg-transparent"
				minVisible={2}
				label={`2xx ${zone.requests2xx}, 3xx ${zone.requests3xx}, 4xx ${zone.errors4xx}, 5xx ${zone.errors5xx}`}
				segments={[
					{ key: "2xx", value: zone.requests2xx, className: "bg-severity-info" },
					{ key: "3xx", value: zone.requests3xx, className: "bg-chart-2" },
					{ key: "4xx", value: zone.errors4xx, className: "bg-severity-warn" },
					{ key: "5xx", value: zone.errors5xx, className: "bg-severity-error" },
				]}
			/>
			<span
				className={cn(
					"truncate font-mono text-2xs tabular-nums",
					rated ? label.className : "text-muted-foreground",
				)}
			>
				{rated ? label.text : EMPTY_VALUE}
			</span>
		</div>
	)
}
