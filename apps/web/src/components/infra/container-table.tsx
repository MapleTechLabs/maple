import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { ListContainersResponse } from "@maple/domain/http"
import type { ContainerSortKey, SortDirection } from "@/api/warehouse/infra"

import { HostStatusBadge } from "./status-badge"
import { ColumnHead, DataTable, ROW_LINK_CLASS, type SortControls } from "@/components/common/data-table"
import { AvgPeak } from "./primitives/avg-peak"
import { MeterRows } from "./primitives/meter-rows"
import { formatWholePercent } from "./format"
import { MetaLine } from "./primitives/meta-line"
import { RelativeTime } from "@/components/common/relative-time"

export type ContainerRow = ListContainersResponse["data"][number]

interface ContainerTableProps {
	containers: ReadonlyArray<ContainerRow>
	/**
	 * Sorting is server-side — the list is paged, so sorting the page in the
	 * browser would only reorder the rows that already came back (see PodTable).
	 */
	sortBy?: ContainerSortKey
	sortDir?: SortDirection
	onSortChange?: (key: ContainerSortKey) => void
	waiting?: boolean
	referenceTime?: string
}

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function ContainerColumns({ sort }: { sort?: Partial<SortControls<ContainerSortKey>> }) {
	return (
		<>
			<ColumnHead<ContainerSortKey>
				label="Container"
				sortKey="containerName"
				{...sort}
				width="w-0 flex-1 min-w-[260px]"
			/>
			<ColumnHead<ContainerSortKey>
				label="Peak saturation"
				sortKey="saturation"
				{...sort}
				width="w-[176px]"
				hidden="hidden md:flex"
			/>
			<ColumnHead<ContainerSortKey>
				label="CPU"
				sortKey="cpuPct"
				{...sort}
				align="right"
				width="w-[132px]"
				hidden="hidden lg:flex"
			/>
			<ColumnHead<ContainerSortKey>
				label="Mem of limit"
				sortKey="memoryPct"
				{...sort}
				align="right"
				width="w-[120px]"
				hidden="hidden lg:flex"
			/>
			<ColumnHead<ContainerSortKey>
				label="Last seen"
				sortKey="lastSeen"
				{...sort}
				align="right"
				width="w-[100px]"
			/>
		</>
	)
}

export function ContainerTableLoading() {
	return (
		<DataTable.Root ariaLabel="Containers">
			<DataTable.Head>
				<ContainerColumns />
			</DataTable.Head>
			<DataTable.SkeletonRows count={6}>
				<div className="w-0 min-w-[260px] flex-1">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="mt-1.5 h-3 w-40" />
				</div>
				<div className="hidden w-[176px] space-y-1.5 md:block">
					<Skeleton className="h-2.5 w-[176px]" />
					<Skeleton className="h-2.5 w-[176px]" />
				</div>
				<Skeleton className="hidden h-3 w-[132px] lg:block" />
				<Skeleton className="hidden h-3 w-[120px] lg:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function ContainerTable({
	containers,
	sortBy = "saturation",
	sortDir = "desc",
	onSortChange,
	waiting,
	referenceTime,
}: ContainerTableProps) {
	return (
		<DataTable.Root ariaLabel="Containers" waiting={waiting}>
			<DataTable.Head>
				<ContainerColumns sort={{ currentKey: sortBy, dir: sortDir, onSort: onSortChange }} />
			</DataTable.Head>
			{containers.length === 0 && <DataTable.Empty>No containers match your filter.</DataTable.Empty>}

			{containers.map((container) => (
				<Link
					key={`${container.hostName}/${container.containerName}`}
					to="/infra/containers/$containerName"
					params={{ containerName: container.containerName }}
					search={container.hostName ? { host: container.hostName } : {}}
					className={ROW_LINK_CLASS}
				>
					<div className="w-0 min-w-[260px] flex-1">
						<div className="flex items-center gap-2">
							<span className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary">
								{container.containerName}
							</span>
							<HostStatusBadge
								quiet
								lastSeen={container.lastSeen}
								referenceTime={referenceTime}
							/>
						</div>
						<MetaLine
							items={[
								container.imageName && `image ${container.imageName}`,
								container.hostName && `host ${container.hostName}`,
								container.composeProject && `compose ${container.composeProject}`,
							]}
						/>
					</div>
					<div className="hidden w-[176px] md:block">
						<MeterRows
							meters={[
								{ label: "CPU", fraction: container.cpuPctPeak },
								{ label: "MEM", fraction: container.memoryPctPeak },
							]}
						/>
					</div>
					<div className="hidden w-[132px] text-right lg:block">
						<AvgPeak
							avg={container.cpuPct}
							peak={container.cpuPctPeak}
							format={formatWholePercent}
						/>
					</div>
					<div className="hidden w-[120px] text-right lg:block">
						<AvgPeak
							avg={container.memoryPct}
							peak={container.memoryPctPeak}
							format={formatWholePercent}
						/>
					</div>
					<div className="w-[100px] text-right">
						<RelativeTime
							value={container.lastSeen}
							mono
							className="cursor-default text-2xs text-muted-foreground"
						/>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
