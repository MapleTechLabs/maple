import { Link } from "@tanstack/react-router"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"

import type { ListWorkloadsResponse } from "@maple/domain/http"
import type { WorkloadKind } from "@/api/warehouse/infra"

import { HostStatusBadge } from "./status-badge"
import { MeterRows } from "./primitives/meter-rows"
import { MetaLine } from "./primitives/meta-line"
import { restartTone } from "./pod-restarts"
import {
	ColumnHead,
	DataTable,
	type SortControls,
	ROW_LINK_CLASS,
	useTableSort,
} from "@/components/common/data-table"
import { RelativeTime } from "@/components/common/relative-time"

export type WorkloadRow = ListWorkloadsResponse["data"][number]

type SortKey =
	| "workloadName"
	| "podCount"
	| "restarts"
	| "peakCpuLimitPct"
	| "peakMemoryLimitPct"
	| "lastSeen"

interface WorkloadTableProps {
	workloads: ReadonlyArray<WorkloadRow>
	kind: WorkloadKind
	waiting?: boolean
	referenceTime?: string
}

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function WorkloadColumns({ sort, kind }: { sort?: SortControls<SortKey>; kind?: WorkloadKind }) {
	return (
		<>
			<ColumnHead<SortKey>
				label="Workload"
				sortKey="workloadName"
				{...sort}
				width="w-0 flex-1 min-w-[260px]"
			/>
			<ColumnHead<SortKey> label={kind === "job" ? "Completions" : "Ready"} width="w-[110px]" />
			<ColumnHead<SortKey> label="Pods" sortKey="podCount" {...sort} align="right" width="w-[60px]" />
			<ColumnHead<SortKey>
				label="Restarts"
				sortKey="restarts"
				{...sort}
				align="right"
				width="w-[140px]"
			/>
			<ColumnHead<SortKey>
				label="CPU peak"
				sortKey="peakCpuLimitPct"
				{...sort}
				align="right"
				width="w-[140px]"
				hidden="hidden md:flex"
			/>
			<ColumnHead<SortKey>
				label="Memory peak"
				sortKey="peakMemoryLimitPct"
				{...sort}
				align="right"
				width="w-[140px]"
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
				<Skeleton className="h-3 w-[110px]" />
				<Skeleton className="h-3 w-[60px]" />
				<Skeleton className="h-3 w-[140px]" />
				<Skeleton className="hidden h-3 w-[140px] md:block" />
				<Skeleton className="hidden h-3 w-[140px] lg:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

/**
 * Ready against desired, from the cluster collector. A job counts completions, so a
 * running job is not "short"; its failed pods are what reads as trouble.
 */
function ReplicaCell({ workload, kind }: { workload: WorkloadRow; kind: WorkloadKind }) {
	const { desiredReplicas: desired, readyReplicas: ready, failedPods } = workload
	if (desired === null || ready === null) {
		return <span className="text-muted-foreground">—</span>
	}
	const tone: Tone =
		kind === "job"
			? failedPods > 0
				? "crit"
				: "neutral"
			: ready === 0 && desired > 0
				? "crit"
				: ready < desired
					? "warn"
					: "neutral"
	return (
		<span className={TONE_TEXT[tone]}>
			{ready} / {desired}
			{kind === "job" && failedPods > 0 && ` · ${failedPods} failed`}
		</span>
	)
}

export function WorkloadTable({ workloads, kind, waiting, referenceTime }: WorkloadTableProps) {
	// No initial key: the server already sorts worst first (missing replicas, failures, restarts, saturation).
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<WorkloadRow, SortKey>(workloads, {
		initialKey: null,
		stringKeys: ["workloadName"],
		resettable: true,
	})

	return (
		<DataTable.Root ariaLabel="Workloads" waiting={waiting}>
			<DataTable.Head>
				<WorkloadColumns
					kind={kind}
					sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }}
				/>
			</DataTable.Head>
			{sorted.length === 0 && <DataTable.Empty>No workloads match your filter.</DataTable.Empty>}

			{sorted.map((wl) => (
				<Link
					key={`${wl.clusterName}/${wl.namespace}/${wl.workloadName}`}
					to="/infra/kubernetes/workloads/$kind/$workloadName"
					params={{ kind, workloadName: wl.workloadName }}
					search={wl.namespace ? { namespace: wl.namespace } : {}}
					className={ROW_LINK_CLASS}
				>
					<div className="w-0 min-w-[260px] flex-1">
						<div className="flex items-center gap-2">
							<TruncatedText
								text={wl.workloadName}
								mono
								className="text-xs font-medium text-foreground transition-colors group-hover:text-primary"
							/>
							<HostStatusBadge quiet lastSeen={wl.lastSeen} referenceTime={referenceTime} />
						</div>
						<MetaLine items={[wl.namespace && `ns ${wl.namespace}`, `kind ${kind}`]} />
					</div>
					<div className="w-[110px] font-mono text-xs tabular-nums">
						<ReplicaCell workload={wl} kind={kind} />
					</div>
					<div className="w-[60px] text-right font-mono text-xs tabular-nums text-foreground/80">
						{wl.podCount.toLocaleString()}
					</div>
					<div
						className={cn(
							"flex w-[140px] flex-col items-end font-mono text-xs tabular-nums",
							TONE_TEXT[restartTone(wl.restarts, wl.lastTerminatedReason)],
						)}
					>
						<span>{wl.restarts.toLocaleString()}</span>
						{wl.restarts > 0 && wl.lastTerminatedReason && (
							<span className="text-2xs text-muted-foreground">{wl.lastTerminatedReason}</span>
						)}
					</div>
					<div className="hidden w-[140px] md:block">
						<MeterRows hideLabels meters={[{ label: "CPU", fraction: wl.peakCpuLimitPct }]} />
					</div>
					<div className="hidden w-[140px] lg:block">
						<MeterRows hideLabels meters={[{ label: "MEM", fraction: wl.peakMemoryLimitPct }]} />
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
