import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { ListWorkloadsResponse } from "@maple/domain/http"
import type { WorkloadKind } from "@/api/warehouse/infra"

import { HostStatusBadge } from "./status-badge"
import { MeterRows } from "./primitives/meter-rows"
import { MetaLine } from "./primitives/meta-line"
import {
	ColumnHead,
	DataTable,
	type SortControls,
	ROW_LINK_CLASS,
	useTableSort,
} from "@/components/common/data-table"
import { RelativeTime } from "@/components/common/relative-time"

export type WorkloadRow = ListWorkloadsResponse["data"][number]

type SortKey = "workloadName" | "namespace" | "podCount" | "avgCpuLimitPct" | "avgMemoryLimitPct" | "lastSeen"

interface WorkloadTableProps {
	workloads: ReadonlyArray<WorkloadRow>
	kind: WorkloadKind
	waiting?: boolean
	referenceTime?: string
}

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function WorkloadColumns({ sort }: { sort?: SortControls<SortKey> }) {
	return (
		<>
			<ColumnHead<SortKey>
				label="Workload"
				sortKey="workloadName"
				{...sort}
				width="w-0 flex-1 min-w-[260px]"
			/>
			<ColumnHead<SortKey> label="Pods" sortKey="podCount" {...sort} align="right" width="w-[60px]" />
			<ColumnHead<SortKey>
				label="Avg CPU"
				sortKey="avgCpuLimitPct"
				{...sort}
				align="right"
				width="w-[160px]"
				hidden="hidden md:flex"
			/>
			<ColumnHead<SortKey>
				label="Avg memory"
				sortKey="avgMemoryLimitPct"
				{...sort}
				align="right"
				width="w-[160px]"
				hidden="hidden lg:flex"
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

export function WorkloadTableLoading() {
	return (
		<DataTable.Root ariaLabel="Workloads">
			<DataTable.Head>
				<WorkloadColumns />
			</DataTable.Head>
			<DataTable.SkeletonRows count={4}>
				<div className="w-0 min-w-[260px] flex-1">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="mt-1.5 h-3 w-32" />
				</div>
				<Skeleton className="h-3 w-[60px]" />
				<Skeleton className="hidden h-3 w-[160px] md:block" />
				<Skeleton className="hidden h-3 w-[160px] lg:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function WorkloadTable({ workloads, kind, waiting, referenceTime }: WorkloadTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<WorkloadRow, SortKey>(workloads, {
		initialKey: "avgCpuLimitPct",
		stringKeys: ["workloadName", "namespace"],
	})

	return (
		<DataTable.Root ariaLabel="Workloads" waiting={waiting}>
			<DataTable.Head>
				<WorkloadColumns sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }} />
			</DataTable.Head>
			{sorted.length === 0 && <DataTable.Empty>No workloads match your filter.</DataTable.Empty>}

			{sorted.map((wl) => (
				<Link
					key={`${wl.namespace}/${wl.workloadName}`}
					to="/infra/kubernetes/workloads/$kind/$workloadName"
					params={{ kind, workloadName: wl.workloadName }}
					search={wl.namespace ? { namespace: wl.namespace } : {}}
					className={ROW_LINK_CLASS}
				>
					<div className="w-0 min-w-[260px] flex-1">
						<div className="flex items-center gap-2">
							<span className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
								{wl.workloadName}
							</span>
							<HostStatusBadge quiet lastSeen={wl.lastSeen} referenceTime={referenceTime} />
						</div>
						<MetaLine items={[wl.namespace && `ns ${wl.namespace}`, `kind ${kind}`]} />
					</div>
					<div className="w-[60px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
						{wl.podCount}
					</div>
					<div className="hidden w-[160px] md:block">
						<MeterRows hideLabels meters={[{ label: "CPU", fraction: wl.avgCpuLimitPct }]} />
					</div>
					<div className="hidden w-[160px] lg:block">
						<MeterRows hideLabels meters={[{ label: "MEM", fraction: wl.avgMemoryLimitPct }]} />
					</div>
					<div className="w-[100px] text-right">
						<RelativeTime
							value={wl.lastSeen}
							mono
							className="cursor-default text-2xs text-muted-foreground"
						/>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
