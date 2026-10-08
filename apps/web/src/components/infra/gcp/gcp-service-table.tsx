import { useMemo, useState } from "react"

import { GCP_INFRA_ROW_LIMIT, GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable, type SortControls } from "@/components/common/data-table"
import { SearchToolbar } from "@/components/common/search-toolbar"
import { useSortState } from "@/hooks/use-table-sort"

import { MetaLine } from "../primitives/meta-line"
import {
	GCP_INFRA_COLUMNS,
	GCP_NAME_SORT,
	formatGcpValue,
	gcpWorkloads,
	sortGcpWorkloads,
	type GcpMetricPoint,
} from "./tabs"

const NAME_WIDTH = "w-0 flex-1 min-w-[240px]"
const VALUE_WIDTH = "w-[104px]"

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function Columns({ service, sort }: { service: GcpInfraServiceId; sort?: SortControls<string> }) {
	return (
		<>
			<ColumnHead<string>
				label={GCP_INFRA_SERVICES[service].identity[0]?.[0] ?? "Name"}
				sortKey={GCP_NAME_SORT}
				{...sort}
				width={NAME_WIDTH}
			/>
			{GCP_INFRA_COLUMNS[service].map((spec) => (
				<ColumnHead<string>
					key={spec.label}
					label={spec.label}
					sortKey={spec.label}
					{...sort}
					align="right"
					width={VALUE_WIDTH}
				/>
			))}
		</>
	)
}

export function GcpServiceTableLoading({ service }: { service: GcpInfraServiceId }) {
	return (
		<DataTable.Root ariaLabel={GCP_INFRA_SERVICES[service].title}>
			<DataTable.Head>
				<Columns service={service} />
			</DataTable.Head>
			<DataTable.SkeletonRows count={5}>
				<div className={NAME_WIDTH}>
					<Skeleton className="h-4 w-40" />
					<Skeleton className="mt-1.5 h-3 w-28" />
				</div>
				{GCP_INFRA_COLUMNS[service].map((spec) => (
					<Skeleton key={spec.label} className={cn("h-3", VALUE_WIDTH)} />
				))}
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

/** One service's workloads over the window: searchable, sortable by any column. */
export function GcpServiceTable({
	service,
	points,
	waiting,
}: {
	service: GcpInfraServiceId
	points: ReadonlyArray<GcpMetricPoint>
	waiting?: boolean
}) {
	const { title, identity } = GCP_INFRA_SERVICES[service]
	const columns = GCP_INFRA_COLUMNS[service]
	const [query, setQuery] = useState("")
	const { sortKey, sortDir, handleSort } = useSortState<string>({
		initialKey: columns[0]?.label ?? GCP_NAME_SORT,
		stringKeys: [GCP_NAME_SORT],
	})

	const workloads = useMemo(() => gcpWorkloads(service, points), [service, points])
	const needle = query.trim().toLowerCase()
	const shown = useMemo(() => {
		const matching =
			needle === ""
				? workloads
				: workloads.filter((workload) => workload.keys.join(" ").toLowerCase().includes(needle))
		return sortGcpWorkloads(service, matching, { key: sortKey ?? GCP_NAME_SORT, dir: sortDir })
	}, [service, workloads, needle, sortKey, sortDir])

	return (
		<div className="space-y-4">
			<SearchToolbar
				value={query}
				onChange={setQuery}
				placeholder={`Search ${title}…`}
				trailing={
					shown.length === workloads.length
						? countLabel(workloads.length, "workload")
						: `${shown.length} of ${countLabel(workloads.length, "workload")}`
				}
			/>
			<DataTable.Root ariaLabel={title} waiting={waiting}>
				<DataTable.Head>
					<Columns
						service={service}
						sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }}
					/>
				</DataTable.Head>
				{shown.length === 0 ? (
					<DataTable.Empty>
						{workloads.length === 0
							? `No ${title} metrics in this time range.`
							: "No workloads match. Clear the search to see them all."}
					</DataTable.Empty>
				) : null}
				{shown.map((workload) => (
					<div
						key={workload.keys.join("\u0000")}
						className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"
					>
						<div className={NAME_WIDTH}>
							<div className="truncate font-mono text-xs font-medium text-foreground">
								{workload.keys[0]}
							</div>
							<MetaLine
								items={workload.keys.slice(1)}
								title={identity
									.slice(1)
									.map(([label], index) => `${label}: ${workload.keys[index + 1] ?? ""}`)
									.join(" · ")}
							/>
						</div>
						{columns.map((spec, index) => {
							const value = workload.values[index]
							return (
								<div
									key={spec.label}
									className={cn(
										"text-right font-mono text-xs tabular-nums",
										VALUE_WIDTH,
										spec.format === "errorRate" && value !== undefined
											? errorRateClass(value)
											: "text-foreground/80",
									)}
								>
									{formatGcpValue(spec.format, value)}
								</div>
							)
						})}
					</div>
				))}
			</DataTable.Root>
			{points.length >= GCP_INFRA_ROW_LIMIT ? (
				<p className="text-xs text-muted-foreground">
					This list is cut off: it shows the first workloads by name.
				</p>
			) : null}
		</div>
	)
}
