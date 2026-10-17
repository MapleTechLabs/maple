import { Link } from "@tanstack/react-router"

import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { utilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable, ROW_LINK_CLASS } from "@/components/common/data-table"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import { MetaLine } from "../primitives/meta-line"
import { BAR_VALUE_TONE } from "../severity-tokens"
import { GcpHealthDot, type GcpBandSpec } from "./gcp-bands"
import { GcpServiceIcon } from "./gcp-service-icon"
import { GCP_WORKLOAD_RULES, rowHealth, type GcpWorkloadRow, type GcpWorkloadScope } from "./list-model"
import { GCP_INFRA_COLUMNS, formatGcpValue, gcpWorkloadId, gcpWorkloadSearch, type GcpColumn } from "./tabs"

const NAME_WIDTH = "w-0 flex-1 min-w-[240px]"
const VALUE_WIDTH = "w-[104px]"

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function Columns({ service }: { service: GcpInfraServiceId }) {
	return (
		<>
			<div className="w-2 shrink-0" />
			<ColumnHead label={GCP_INFRA_SERVICES[service].identity[0][0]} width={NAME_WIDTH} />
			{GCP_INFRA_COLUMNS[service].map((spec) => (
				<ColumnHead key={spec.label} label={spec.label} align="right" width={VALUE_WIDTH} />
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
				<div className="w-2 shrink-0" />
				<div className={cn(NAME_WIDTH, "flex items-center gap-3")}>
					<Skeleton className="size-7 shrink-0 rounded-md" />
					<div>
						<Skeleton className="h-4 w-40" />
						<Skeleton className="mt-1.5 h-3 w-28" />
					</div>
				</div>
				{GCP_INFRA_COLUMNS[service].map((spec) => (
					<Skeleton key={spec.label} className={cn("h-3", VALUE_WIDTH)} />
				))}
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

/** An error rate and a share of a limit take their severity color; every other number is plain. */
export function gcpValueClass(spec: GcpColumn, value: number | undefined): string {
	if (value !== undefined && spec.format === "errorRate") return errorRateClass(value)
	if (value !== undefined && spec.format === "percent" && utilizationLevel(value) !== "ok") {
		return BAR_VALUE_TONE[utilizationLevel(value)]
	}
	return "text-foreground/80"
}

/**
 * The workloads of a service without a list of its own (GKE containers, VMs, URL maps): its
 * curated columns, rows already ordered problems first. A row opens the workload's page.
 */
export function GcpServiceTable({
	service,
	rows,
	spec,
	emptyMessage,
	timeSearch,
	waiting,
}: {
	service: GcpInfraServiceId
	rows: ReadonlyArray<GcpWorkloadRow>
	spec: GcpBandSpec<GcpWorkloadScope>
	emptyMessage: string
	timeSearch: TimeRangeSearch
	waiting?: boolean
}) {
	const { title, identity } = GCP_INFRA_SERVICES[service]
	const columns = GCP_INFRA_COLUMNS[service]
	return (
		<DataTable.Root ariaLabel={title} waiting={waiting}>
			<DataTable.Head>
				<Columns service={service} />
			</DataTable.Head>
			{rows.length === 0 ? <DataTable.Empty>{emptyMessage}</DataTable.Empty> : null}
			{rows.map((row) => (
				<Link
					key={gcpWorkloadId(row.keys)}
					to="/infra/gcp/$service/$name"
					params={{ service, name: row.keys[0] }}
					search={{ ...timeSearch, ...gcpWorkloadSearch(service, row.keys) }}
					className={ROW_LINK_CLASS}
				>
					<GcpHealthDot spec={spec} health={rowHealth(GCP_WORKLOAD_RULES, row)} />
					<div className={cn(NAME_WIDTH, "flex items-center gap-3")}>
						<GcpServiceIcon service={service} />
						<div className="min-w-0 flex-1">
							<div className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary">
								{row.name}
							</div>
							<MetaLine
								items={row.keys.slice(1)}
								title={identity
									.slice(1)
									.map(([label], index) => `${label}: ${row.keys[index + 1]}`)
									.join(" · ")}
							/>
						</div>
					</div>
					{columns.map((column, index) => (
						<div
							key={column.label}
							className={cn(
								"text-right font-mono text-xs tabular-nums",
								VALUE_WIDTH,
								gcpValueClass(column, row.workload.values[index]),
							)}
						>
							{formatGcpValue(column.format, row.workload.values[index])}
						</div>
					))}
				</Link>
			))}
		</DataTable.Root>
	)
}
