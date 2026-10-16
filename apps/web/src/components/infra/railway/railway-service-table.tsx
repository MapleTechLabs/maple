import { Fragment, useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type { RailwayEnvironmentStatus } from "@maple/domain/http"

import { SegmentedBar } from "@maple/ui/components/ui/meter"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatBytes, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { RelativeTime } from "@/components/common/relative-time"
import { StatRailItem } from "@/components/common/stat-rail"

import type { RailwayServiceRow } from "@/api/warehouse/railway-infra"

import { severityLevel } from "../format"
import {
	ColumnHead,
	DataTable,
	ROW_LINK_CLASS,
	type SortControls,
	useTableSort,
} from "@/components/common/data-table"
import { MeterRows } from "../primitives/meter-rows"
import { AvgPeak } from "../primitives/avg-peak"
import { fleetSync, groupRailwayServices, type RailwaySync } from "./list-model"

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

/** The overview's saturation check. The list no longer scopes by it: see `hasConfiguredLimits`. */
export function railwayInScope(row: RailwayServiceRow, scope: RailwayScope): boolean {
	const view = toView(row)
	const bounded = Number.isFinite(view.cpuOfLimit) || Number.isFinite(view.memoryOfLimit)
	if (scope === "unbounded") return !bounded
	if (!bounded) return false
	const level = severityLevel(view.peakOfLimit)
	return scope === "saturated" ? level === "crit" : level === "warn"
}

/** Heaviest services get their own slice of the memory strip; the rest share one. */
const STRIP_SLICES = 6
const STRIP_FILLS = [
	"bg-foreground/45",
	"bg-foreground/36",
	"bg-foreground/29",
	"bg-foreground/23",
	"bg-foreground/18",
	"bg-foreground/14",
]
const LEGEND_NAMES = 3

/**
 * Memory and polling, the two things that hold for every Railway fleet. Railway's limits are the
 * plan ceiling unless someone set one, so a saturation band would read "all healthy" forever.
 */
export function RailwayFleetBand({
	services,
	environments,
	authFailed,
	className,
}: {
	services: ReadonlyArray<RailwayServiceRow>
	environments: ReadonlyArray<RailwayEnvironmentStatus>
	authFailed: boolean
	className?: string
}) {
	const ranked = [...services].sort((a, b) => b.memoryAvg - a.memoryAvg)
	const total = ranked.reduce((sum, row) => sum + row.memoryAvg, 0)
	const rest = ranked.slice(STRIP_SLICES).reduce((sum, row) => sum + row.memoryAvg, 0)
	const segments = [
		...ranked.slice(0, STRIP_SLICES).map((row, index) => ({
			key: `${row.environmentId}:${row.serviceId}`,
			value: row.memoryAvg,
			className: STRIP_FILLS[index],
			title: `${row.serviceName || row.serviceId} ${formatBytes(row.memoryAvg)}`,
		})),
		{ key: "rest", value: rest, className: "bg-foreground/10", title: "the rest" },
	]
	const sync = fleetSync(environments, authFailed)

	return (
		<div className={cn("flex flex-col border-b bg-background md:flex-row md:items-stretch", className)}>
			<div className="flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-[26rem] md:shrink-0">
				<span className="flex items-baseline gap-1.5">
					<span className="font-mono text-base font-semibold tabular-nums">
						{formatBytes(total)}
					</span>
					<span className="text-2xs text-muted-foreground">
						summed average memory across {services.length} {pluralize(services.length, "service")}
					</span>
				</span>
				<SegmentedBar
					className="w-full gap-px bg-transparent"
					minVisible={1}
					label={ranked.map((row) => `${row.serviceName} ${formatBytes(row.memoryAvg)}`).join(", ")}
					segments={segments}
				/>
				<span className="flex gap-3 text-3xs text-muted-foreground">
					{ranked.slice(0, LEGEND_NAMES).map((row) => (
						<span key={`${row.environmentId}:${row.serviceId}`} className="truncate font-mono">
							{row.serviceName || row.serviceId} {formatBytes(row.memoryAvg)}
						</span>
					))}
					{ranked.length > LEGEND_NAMES ? (
						<span className="font-mono">+{ranked.length - LEGEND_NAMES} more</span>
					) : null}
				</span>
			</div>
			<StatRailItem
				size="sm"
				eyebrow="Polling"
				value={
					authFailed
						? "Paused"
						: sync.failing > 0
							? `${sync.failing} of ${environments.length} failing`
							: `${environments.length} ${pluralize(environments.length, "environment")}`
				}
				tone={authFailed || sync.failing > 0 ? "crit" : "neutral"}
				subline={
					authFailed ? (
						"Railway rejected the token"
					) : sync.lastSyncedAt !== null ? (
						<RelativeTime value={sync.lastSyncedAt} prefix="synced" tooltip="title" />
					) : sync.pending > 0 ? (
						"waiting on the first sync"
					) : undefined
				}
				className="flex flex-1 flex-col justify-center border-l"
			/>
		</div>
	)
}

export function RailwayFleetBandLoading({ className }: { className?: string }) {
	return (
		<div className={cn("flex flex-col border-b bg-background md:flex-row md:items-stretch", className)}>
			<div className="flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-[26rem] md:shrink-0">
				<Skeleton className="h-4 w-48" />
				<Skeleton className="h-1.5 w-full rounded-full" />
				<Skeleton className="h-2.5 w-56" />
			</div>
			<div className="flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3">
				<Skeleton className="h-3 w-16" />
				<Skeleton className="h-5 w-28" />
			</div>
		</div>
	)
}

type SortKey = "displayName" | "cpuMax" | "memoryMax" | "peakOfLimit" | "replicas" | "lastSeen"

/** Railway services idle in the millicore range; keep three decimals there so they still differ. */
const formatVcpu = (cores: number) => {
	if (!Number.isFinite(cores) || cores === 0) return "0"
	if (cores >= 10) return cores.toFixed(0)
	if (cores >= 1) return cores.toFixed(2)
	return cores.toFixed(3)
}

function RailwayColumns({ sort, showLimits }: { sort?: SortControls<SortKey>; showLimits: boolean }) {
	return (
		<>
			<ColumnHead<SortKey>
				label="Service"
				sortKey="displayName"
				{...sort}
				width="w-0 flex-1 min-w-[240px]"
			/>
			<ColumnHead<SortKey>
				label="Memory"
				sortKey="memoryMax"
				{...sort}
				align="right"
				width="w-[150px]"
			/>
			<ColumnHead<SortKey> label="vCPU" sortKey="cpuMax" {...sort} align="right" width="w-[140px]" />
			{showLimits ? (
				<ColumnHead<SortKey>
					label="Of limit"
					sortKey="peakOfLimit"
					{...sort}
					width="w-[160px]"
					hidden="hidden lg:flex"
				/>
			) : null}
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
				<RailwayColumns showLimits={false} />
			</DataTable.Head>
			<DataTable.SkeletonRows count={5}>
				<div className="w-0 min-w-[240px] flex-1">
					<Skeleton className="h-4 w-36" />
				</div>
				<Skeleton className="ml-auto h-3 w-[150px]" />
				<Skeleton className="ml-auto h-3 w-[140px]" />
				<Skeleton className="ml-auto h-3 w-[80px]" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

function SyncNote({ sync }: { sync: RailwaySync }) {
	switch (sync.kind) {
		case "synced":
			return <RelativeTime value={sync.at} prefix="synced" tooltip="title" />
		case "pending":
			return <span>waiting on the first sync</span>
		case "unknown":
			return <span>no longer polled</span>
		case "paused":
			return (
				<span className="text-severity-error">
					paused
					{sync.lastSyncedAt !== null ? (
						<>
							{" · last data "}
							<RelativeTime value={sync.lastSyncedAt} tooltip="title" />
						</>
					) : null}
				</span>
			)
		case "failing":
			return (
				<span className="truncate text-severity-error" title={sync.error}>
					sync failing: {sync.error}
				</span>
			)
	}
}

/**
 * One header per project / environment, which is how Railway lays out its own canvas. The header
 * carries that environment's sync state, so a failed poll shows where the gap is.
 */
export function RailwayServiceTable({
	services,
	environments,
	authFailed,
	showLimits,
	waiting,
}: {
	services: ReadonlyArray<RailwayServiceRow>
	environments: ReadonlyArray<RailwayEnvironmentStatus>
	authFailed: boolean
	/** `hasConfiguredLimits` over the whole fleet, never the searched rows: one row can't tell a ceiling. */
	showLimits: boolean
	waiting?: boolean
}) {
	const rows = useMemo(() => services.map(toView), [services])
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<RailwayRowView, SortKey>(rows, {
		initialKey: "memoryMax",
		stringKeys: ["displayName"],
	})
	// Grouping only decides which header a row sits under; order inside a group is the table sort.
	const groups = groupRailwayServices(sorted, environments, authFailed)

	return (
		<DataTable.Root ariaLabel="Railway services" waiting={waiting}>
			<DataTable.Head>
				<RailwayColumns
					sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }}
					showLimits={showLimits}
				/>
			</DataTable.Head>
			{groups.map((group) => (
				<Fragment key={group.key}>
					<div className="flex items-center gap-2.5 border-b border-border/40 bg-muted/30 px-4 py-2 font-mono text-2xs">
						<span className="font-medium text-foreground">{group.projectName}</span>
						<span className="text-muted-foreground">/ {group.environmentName}</span>
						<span className="ml-auto flex min-w-0 items-center gap-1.5 text-muted-foreground">
							<span className="shrink-0">
								{group.services.length} {pluralize(group.services.length, "service")} ·{" "}
								{formatBytes(group.memoryAvg)} ·
							</span>
							<SyncNote sync={group.sync} />
						</span>
					</div>
					{group.services.map((row) => (
						<RailwayRow
							key={`${row.environmentId}:${row.serviceId}`}
							row={row}
							showLimits={showLimits}
						/>
					))}
				</Fragment>
			))}
		</DataTable.Root>
	)
}

function RailwayRow({ row, showLimits }: { row: RailwayRowView; showLimits: boolean }) {
	return (
		<Link
			to="/infra/railway/$serviceId"
			params={{ serviceId: row.serviceId }}
			search={{ environmentId: row.environmentId }}
			className={ROW_LINK_CLASS}
		>
			<div className="w-0 min-w-[240px] flex-1">
				<div
					className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary"
					title={row.displayName}
				>
					{row.displayName}
				</div>
			</div>
			<div className="w-[150px] text-right">
				<AvgPeak
					avg={row.memoryAvg}
					peak={row.memoryMax}
					format={formatBytes}
					note="Summed across replicas."
				/>
			</div>
			<div className="w-[140px] text-right">
				<AvgPeak
					avg={row.cpuAvg}
					peak={row.cpuMax}
					format={formatVcpu}
					note="Summed across replicas."
				/>
			</div>
			{showLimits ? (
				<div className="hidden w-[160px] lg:block">
					<MeterRows
						meters={[
							{ label: "CPU", fraction: row.cpuOfLimit },
							{ label: "MEM", fraction: row.memoryOfLimit },
						]}
					/>
				</div>
			) : null}
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
	)
}
