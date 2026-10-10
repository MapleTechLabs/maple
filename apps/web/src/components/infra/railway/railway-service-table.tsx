import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { RelativeTime } from "@/components/common/relative-time"

import type { RailwayServiceRow } from "@/api/warehouse/railway-infra"

import { severityLevel } from "../format"
import {
	ColumnHead,
	DataTable,
	ROW_LINK_CLASS,
	type SortControls,
	useTableSort,
} from "@/components/common/data-table"
import { FleetBand, FleetBandLoading } from "../primitives/fleet-band"
import { MetaLine } from "../primitives/meta-line"
import { MeterRows } from "../primitives/meter-rows"
import { AvgPeak } from "../primitives/avg-peak"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { formatBytes } from "@maple/ui/lib/format"

export type RailwayScope = "saturated" | "elevated" | "unbounded"

/** Peak use against the service's own limit, 0..1, or NaN when Railway reported no limit. */
const ofLimit = (peak: number, limit: number) => (limit > 0 ? peak / limit : Number.NaN)

interface RailwayRowView extends RailwayServiceRow {
	readonly cpuOfLimit: number
	readonly memoryOfLimit: number
	readonly peakOfLimit: number
	readonly displayName: string
}

function toView(row: RailwayServiceRow): RailwayRowView {
	const cpuOfLimit = ofLimit(row.cpuMax, row.cpuLimit)
	const memoryOfLimit = ofLimit(row.memoryMax, row.memoryLimit)
	const finite = [cpuOfLimit, memoryOfLimit].filter(Number.isFinite)
	return {
		...row,
		cpuOfLimit,
		memoryOfLimit,
		peakOfLimit: finite.length > 0 ? Math.max(...finite) : 0,
		displayName: row.serviceName || row.serviceId,
	}
}

export function railwayInScope(row: RailwayServiceRow, scope: RailwayScope): boolean {
	const view = toView(row)
	const bounded = Number.isFinite(view.cpuOfLimit) || Number.isFinite(view.memoryOfLimit)
	if (scope === "unbounded") return !bounded
	if (!bounded) return false
	const level = severityLevel(view.peakOfLimit)
	return scope === "saturated" ? level === "crit" : level === "warn"
}

export function RailwaySummaryBand({
	services,
	activeScope,
	onScopeChange,
	className,
}: {
	services: ReadonlyArray<RailwayServiceRow>
	activeScope?: RailwayScope
	onScopeChange: (scope: RailwayScope | undefined) => void
	className?: string
}) {
	const saturated = services.filter((row) => railwayInScope(row, "saturated")).length
	const elevated = services.filter((row) => railwayInScope(row, "elevated")).length
	const unbounded = services.filter((row) => railwayInScope(row, "unbounded")).length
	return (
		<FleetBand<RailwayScope>
			total={services.length}
			noun="service"
			caption="share of services by peak CPU or memory against their limit"
			segments={[
				{
					key: "healthy",
					count: Math.max(services.length - saturated - elevated - unbounded, 0),
					className: TONE_FILL.ok,
				},
				{ key: "elevated", count: elevated, className: TONE_FILL.warn },
				{ key: "saturated", count: saturated, className: TONE_FILL.crit },
			]}
			cells={[
				{ scope: "saturated", label: "Saturated", hint: "≥90%", value: saturated, tone: "crit" },
				{ scope: "elevated", label: "Elevated", hint: "≥60%", value: elevated, tone: "warn" },
				{
					scope: "unbounded",
					label: "No limit",
					hint: "unmeasured",
					value: unbounded,
					tone: "neutral",
				},
			]}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			className={className}
		/>
	)
}

export function RailwaySummaryBandLoading({ className }: { className?: string }) {
	return <FleetBandLoading cells={3} className={className} />
}

type SortKey = "displayName" | "cpuMax" | "memoryMax" | "peakOfLimit" | "replicas" | "lastSeen"

/** Railway services idle in the millicore range; keep three decimals there so they still differ. */
const formatVcpu = (cores: number) => {
	if (!Number.isFinite(cores) || cores === 0) return "0"
	if (cores >= 10) return cores.toFixed(0)
	if (cores >= 1) return cores.toFixed(2)
	return cores.toFixed(3)
}

function RailwayColumns({ sort }: { sort?: SortControls<SortKey> }) {
	return (
		<>
			<ColumnHead<SortKey>
				label="Service"
				sortKey="displayName"
				{...sort}
				width="w-0 flex-1 min-w-[240px]"
			/>
			<ColumnHead<SortKey> label="vCPU" sortKey="cpuMax" {...sort} align="right" width="w-[140px]" />
			<ColumnHead<SortKey>
				label="Memory"
				sortKey="memoryMax"
				{...sort}
				align="right"
				width="w-[150px]"
			/>
			<ColumnHead<SortKey>
				label="Of limit"
				sortKey="peakOfLimit"
				{...sort}
				width="w-[160px]"
				hidden="hidden lg:flex"
			/>
			<ColumnHead<SortKey>
				label="Replicas"
				sortKey="replicas"
				{...sort}
				align="right"
				width="w-[80px]"
			/>
			<ColumnHead<SortKey>
				label="Last seen"
				sortKey="lastSeen"
				{...sort}
				align="right"
				width="w-[100px]"
			/>
		</>
	)
}

export function RailwayServiceTableLoading() {
	return (
		<DataTable.Root ariaLabel="Railway services">
			<DataTable.Head>
				<RailwayColumns />
			</DataTable.Head>
			<DataTable.SkeletonRows count={5}>
				<div className="w-0 min-w-[240px] flex-1">
					<Skeleton className="h-4 w-36" />
					<Skeleton className="mt-1.5 h-3 w-28" />
				</div>
				<Skeleton className="ml-auto h-3 w-[140px]" />
				<Skeleton className="ml-auto h-3 w-[150px]" />
				<Skeleton className="hidden h-6 w-[160px] lg:block" />
				<Skeleton className="ml-auto h-3 w-[80px]" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function RailwayServiceTable({
	services,
	waiting,
}: {
	services: ReadonlyArray<RailwayServiceRow>
	waiting?: boolean
}) {
	const rows = useMemo(() => services.map(toView), [services])
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<RailwayRowView, SortKey>(rows, {
		initialKey: "memoryMax",
		stringKeys: ["displayName"],
	})

	return (
		<DataTable.Root ariaLabel="Railway services" waiting={waiting}>
			<DataTable.Head>
				<RailwayColumns sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }} />
			</DataTable.Head>
			{sorted.map((row) => (
				<Link
					key={`${row.environmentId}:${row.serviceId}`}
					to="/infra/railway/$serviceId"
					params={{ serviceId: row.serviceId }}
					search={{ environmentId: row.environmentId }}
					className={ROW_LINK_CLASS}
				>
					<div className="w-0 min-w-[240px] flex-1">
						<div className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary">
							{row.displayName}
						</div>
						<MetaLine items={[row.projectName, row.environmentName]} />
					</div>
					<div className="w-[140px] text-right">
						<AvgPeak avg={row.cpuAvg} peak={row.cpuMax} format={formatVcpu} />
					</div>
					<div className="w-[150px] text-right">
						<AvgPeak avg={row.memoryAvg} peak={row.memoryMax} format={formatBytes} />
					</div>
					<div className="hidden w-[160px] lg:block">
						<MeterRows
							meters={[
								{ label: "CPU", fraction: row.cpuOfLimit },
								{ label: "MEM", fraction: row.memoryOfLimit },
							]}
						/>
					</div>
					<div className="w-[80px] text-right font-mono text-xs tabular-nums text-foreground/80">
						{row.replicas}
					</div>
					<div className="w-[100px] text-right">
						<RelativeTime
							value={row.lastSeen}
							mono
							className="cursor-default text-2xs text-muted-foreground"
						/>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
