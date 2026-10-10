import { Link } from "@tanstack/react-router"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"

import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { ListNodesResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import {
	ColumnHead,
	DataTable,
	type SortControls,
	ROW_LINK_CLASS,
	useTableSort,
} from "@/components/common/data-table"
import { MetaLine } from "./primitives/meta-line"
import { formatUptime } from "@maple/ui/lib/format"
import { RelativeTime } from "@/components/common/relative-time"

export type NodeRow = ListNodesResponse["data"][number]

type SortKey = "nodeName" | "cpuUsage" | "uptime" | "lastSeen"

interface NodeTableProps {
	nodes: ReadonlyArray<NodeRow>
	waiting?: boolean
	referenceTime?: string
}

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function NodeColumns({ sort }: { sort?: SortControls<SortKey> }) {
	return (
		<>
			<ColumnHead<SortKey> label="Node" sortKey="nodeName" {...sort} width="w-0 flex-1 min-w-[260px]" />
			<ColumnHead<SortKey>
				label="CPU cores"
				sortKey="cpuUsage"
				{...sort}
				align="right"
				width="w-[110px]"
				hidden="hidden md:flex"
			/>
			<ColumnHead<SortKey>
				label="Uptime"
				sortKey="uptime"
				{...sort}
				align="right"
				width="w-[100px]"
				hidden="hidden md:flex"
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

export function NodeTableLoading() {
	return (
		<DataTable.Root ariaLabel="Nodes">
			<DataTable.Head>
				<NodeColumns />
			</DataTable.Head>
			<DataTable.SkeletonRows count={4}>
				<div className="w-0 min-w-[260px] flex-1">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="mt-1.5 h-3 w-32" />
				</div>
				<Skeleton className="hidden h-3 w-[110px] md:block" />
				<Skeleton className="hidden h-3 w-[100px] md:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function NodeTable({ nodes, waiting, referenceTime }: NodeTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<NodeRow, SortKey>(nodes, {
		initialKey: "cpuUsage",
		stringKeys: ["nodeName"],
	})

	return (
		<DataTable.Root ariaLabel="Nodes" waiting={waiting}>
			<DataTable.Head>
				<NodeColumns sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }} />
			</DataTable.Head>
			{sorted.length === 0 && <DataTable.Empty>No nodes match your search.</DataTable.Empty>}

			{sorted.map((node) => (
				<Link
					key={node.nodeName}
					to="/infra/kubernetes/nodes/$nodeName"
					params={{ nodeName: node.nodeName }}
					className={ROW_LINK_CLASS}
				>
					<div className="w-0 min-w-[260px] flex-1">
						<div className="flex items-center gap-2">
							<TruncatedText
								text={node.nodeName}
								mono
								className="text-xs font-medium text-foreground transition-colors group-hover:text-primary"
							/>
							<HostStatusBadge quiet lastSeen={node.lastSeen} referenceTime={referenceTime} />
						</div>
						<MetaLine items={[node.kubeletVersion && `kubelet ${node.kubeletVersion}`]} />
					</div>
					<div className="hidden w-[110px] text-right font-mono text-xs tabular-nums text-foreground/80 md:block">
						{Number.isFinite(node.cpuUsage) ? node.cpuUsage.toFixed(2) : "—"}
					</div>
					<div className="hidden w-[100px] text-right font-mono text-xs tabular-nums text-foreground/80 md:block">
						{formatUptime(node.uptime)}
					</div>
					<div className="w-[100px] text-right">
						<RelativeTime
							value={node.lastSeen}
							mono
							className="cursor-default text-2xs text-muted-foreground"
						/>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
