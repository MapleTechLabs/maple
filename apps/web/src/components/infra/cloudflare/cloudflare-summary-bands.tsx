import { TONE_FILL } from "@maple/ui/lib/tone"

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import { FleetBand, FleetBandLoading } from "../primitives/fleet-band"
import {
	CPU_HEAVY_P99_MS,
	MIN_RATED_REQUESTS,
	workerHealth,
	workerInScope,
	zoneHealth,
	type WorkerListRow,
	type WorkerScope,
	type ZoneScope,
} from "./list-model"

const count = <T,>(rows: ReadonlyArray<T>, keep: (row: T) => boolean) => rows.filter(keep).length

/** Counts are over the unfiltered fleet, so the band shows what a scope or search just hid. */
export function CloudflareZoneBand({
	zones,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: {
	zones: ReadonlyArray<CloudflareZoneRow>
	activeScope?: ZoneScope
	onScopeChange: (scope: ZoneScope | undefined) => void
	waiting?: boolean
	className?: string
}) {
	const serving5xx = count(zones, (z) => zoneHealth(z) === "serving5xx")
	const mostly4xx = count(zones, (z) => zoneHealth(z) === "mostly4xx")
	const lowVolume = count(zones, (z) => zoneHealth(z) === "lowVolume")
	return (
		<FleetBand<ZoneScope>
			total={zones.length}
			noun="zone"
			caption="each zone by its worst signal over the window"
			segments={[
				{
					key: "healthy",
					count: zones.length - serving5xx - mostly4xx - lowVolume,
					className: TONE_FILL.ok,
				},
				{ key: "mostly 4xx", count: mostly4xx, className: TONE_FILL.warn },
				{ key: "serving 5xx", count: serving5xx, className: TONE_FILL.crit },
				{ key: "low volume", count: lowVolume, className: TONE_FILL.neutral },
			]}
			cells={[
				{
					scope: "serving5xx",
					label: "Serving 5xx",
					hint: "≥1% of requests",
					value: serving5xx,
					tone: "crit",
				},
				{
					scope: "mostly4xx",
					label: "Mostly 4xx",
					hint: "≥50% of requests",
					value: mostly4xx,
					tone: "warn",
				},
				{
					scope: "lowVolume",
					label: "Low volume",
					hint: `<${MIN_RATED_REQUESTS} requests, not rated`,
					value: lowVolume,
					tone: "neutral",
				},
			]}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			waiting={waiting}
			className={className}
		/>
	)
}

export function CloudflareWorkerBand({
	rows,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: {
	rows: ReadonlyArray<WorkerListRow>
	activeScope?: WorkerScope
	onScopeChange: (scope: WorkerScope | undefined) => void
	waiting?: boolean
	className?: string
}) {
	const erroring = count(rows, (r) => workerHealth(r) === "erroring")
	const slow = count(rows, (r) => workerHealth(r) === "slow")
	return (
		<FleetBand<WorkerScope>
			total={rows.length}
			noun="Worker"
			caption="each Worker by its worst signal: errors, then p99 duration"
			segments={[
				{ key: "healthy", count: rows.length - erroring - slow, className: TONE_FILL.ok },
				{ key: "slow", count: slow, className: TONE_FILL.warn },
				{ key: "erroring", count: erroring, className: TONE_FILL.crit },
			]}
			cells={[
				{
					scope: "erroring",
					label: "Erroring",
					hint: "≥1% of invocations or DO calls",
					value: erroring,
					tone: "crit",
				},
				{
					scope: "slow",
					label: "Slow",
					hint: "duration p99 ≥1s",
					value: count(rows, (r) => workerInScope(r, "slow")),
					tone: "warn",
				},
				{
					scope: "cpuHeavy",
					label: "CPU heavy",
					hint: `cpu p99 ≥${CPU_HEAVY_P99_MS}ms`,
					value: count(rows, (r) => workerInScope(r, "cpuHeavy")),
					tone: "neutral",
				},
			]}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			waiting={waiting}
			className={className}
		/>
	)
}

export function CloudflareBandLoading({ className }: { className?: string }) {
	return <FleetBandLoading cells={3} className={className} />
}
