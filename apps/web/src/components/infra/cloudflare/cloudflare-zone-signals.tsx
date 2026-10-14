import { useMemo } from "react"

import { cn } from "@maple/ui/lib/utils"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { errorRateClass } from "@maple/ui/lib/error-rate"

import type {
	CloudflareZoneCacheBucket,
	CloudflareZoneLatencyBucket,
	CloudflareZoneRow,
	CloudflareZoneStatusBucket,
} from "@/api/warehouse/cloudflare-infra"
import { CorrelationStrips, type StripSeries } from "@/components/infra/service-lens/correlation-strips"
import {
	cacheHitRows,
	errorShareRows,
	latencyRows,
	requestRows,
	zoneSignalTotals,
	type ZoneSignalTotals,
} from "./zone-signals"
import { CLIENT_ERROR_NOTABLE, classifyZone, type ZoneHealth } from "./list-model"

/** The zone's signals on one time axis, each with its window total at the right edge. */
export function CloudflareZoneSignals({
	statusBuckets,
	cacheBuckets,
	latencyBuckets,
	zoneRow,
	ignoredFilters = [],
	latencyIgnoredFilters = [],
	waiting,
}: {
	/** Active filters the traffic strips could not apply; they read as zone-wide when non-empty. */
	ignoredFilters?: ReadonlyArray<string>
	/** The same for latency, which no dimension filter narrows. */
	latencyIgnoredFilters?: ReadonlyArray<string>
	statusBuckets: ReadonlyArray<CloudflareZoneStatusBucket>
	cacheBuckets: ReadonlyArray<CloudflareZoneCacheBucket>
	latencyBuckets: ReadonlyArray<CloudflareZoneLatencyBucket>
	/** The list rollup's row for this zone: bandwidth and latency totals. */
	zoneRow: CloudflareZoneRow | null
	waiting?: boolean
}) {
	const totals = useMemo(() => zoneSignalTotals(statusBuckets, cacheBuckets), [statusBuckets, cacheBuckets])
	const xDomain = useMemo(
		() => [...new Set([...statusBuckets, ...cacheBuckets].map((b) => b.bucket))].toSorted(),
		[statusBuckets, cacheBuckets],
	)
	const series = useMemo(
		() =>
			buildStrips({ statusBuckets, cacheBuckets, latencyBuckets, zoneRow, totals }).map((strip) =>
				(strip.id === "cf-latency" ? latencyIgnoredFilters : ignoredFilters).length > 0
					? { ...strip, source: `zone-wide, filters not applied · ${strip.source}` }
					: strip,
			),
		[statusBuckets, cacheBuckets, latencyBuckets, zoneRow, totals, ignoredFilters, latencyIgnoredFilters],
	)

	return <CorrelationStrips series={series} xDomain={xDomain} waiting={waiting} />
}

const ZONE_HEALTH_DOT = {
	serving5xx: "bg-severity-error",
	mostly4xx: "bg-severity-warn",
	ok: "bg-severity-info",
	lowVolume: "bg-muted-foreground",
} satisfies Record<ZoneHealth, string>

export function zoneSeverityClass(totals: ZoneSignalTotals): string {
	return ZONE_HEALTH_DOT[classifyZone(totals.requests, totals.serverErrorRate, totals.clientErrorRate)]
}

function buildStrips({
	statusBuckets,
	cacheBuckets,
	latencyBuckets,
	zoneRow,
	totals,
}: {
	statusBuckets: ReadonlyArray<CloudflareZoneStatusBucket>
	cacheBuckets: ReadonlyArray<CloudflareZoneCacheBucket>
	latencyBuckets: ReadonlyArray<CloudflareZoneLatencyBucket>
	zoneRow: CloudflareZoneRow | null
	totals: ZoneSignalTotals
}): StripSeries[] {
	const strips: StripSeries[] = [
		{
			id: "cf-requests",
			label: "Requests",
			source: "by status class",
			rows: requestRows(statusBuckets),
			unit: "count",
			summary: (
				<Summary
					value={formatNumber(totals.requests)}
					caption={zoneRow ? `${formatBytes(zoneRow.bytes)} out` : undefined}
				/>
			),
		},
		{
			id: "cf-errors",
			label: "Errors",
			source: "4xx and 5xx share",
			rows: errorShareRows(statusBuckets),
			unit: "percent",
			summary: (
				<Summary
					value={`${formatPercent(totals.clientErrorRate)} 4xx`}
					valueClassName={
						totals.clientErrorRate >= CLIENT_ERROR_NOTABLE ? "text-severity-warn" : undefined
					}
					caption={`5xx ${formatNumber(totals.serverErrors)} · ${formatErrorRate(totals.serverErrorRate)}`}
					captionClassName={errorRateClass(totals.serverErrorRate, {
						neutral: "text-muted-foreground",
					})}
				/>
			),
		},
		{
			id: "cf-cache",
			label: "Cache hit",
			source: "of cacheable traffic",
			rows: cacheHitRows(cacheBuckets),
			unit: "percent",
			summary: (
				<Summary
					value={totals.cacheHitRate === null ? EMPTY_VALUE : formatPercent(totals.cacheHitRate)}
					caption={
						totals.cacheHitRate === null
							? "nothing cacheable"
							: `${formatPercent(totals.cacheableShare)} is cacheable`
					}
				/>
			),
		},
	]

	// Only zones whose plan exposes timing quantiles get a latency strip; the rest say so in the rail.
	const latency = latencyRows(latencyBuckets)
	if (latency.length > 0) {
		strips.push({
			id: "cf-latency",
			label: "Latency",
			source: "TTFB and origin p99",
			rows: latency,
			unit: "milliseconds",
			summary: (
				<Summary
					value={zoneRow ? formatLatency(zoneRow.ttfbP99Ms) : EMPTY_VALUE}
					caption={zoneRow ? `origin ${formatLatency(zoneRow.originP99Ms)}` : undefined}
				/>
			),
		})
	}
	return strips
}

function Summary({
	value,
	caption,
	valueClassName,
	captionClassName,
}: {
	value: string
	caption?: string
	valueClassName?: string
	captionClassName?: string
}) {
	return (
		<>
			<span
				className={cn("font-mono text-sm font-semibold tabular-nums text-foreground", valueClassName)}
			>
				{value}
			</span>
			{caption === undefined ? null : (
				<span className={cn("font-mono text-3xs text-muted-foreground", captionClassName)}>
					{caption}
				</span>
			)}
		</>
	)
}
