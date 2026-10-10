import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { countLabel } from "@maple/ui/lib/format"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { utilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable, ROW_LINK_CLASS, type SortControls } from "@/components/common/data-table"
import { FilteredEmpty } from "@/components/common/filtered-empty"
import { SearchToolbar } from "@/components/common/search-toolbar"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { useSortState } from "@/hooks/use-table-sort"

import { FleetBand, FleetBandLoading } from "../primitives/fleet-band"
import { MetaLine } from "../primitives/meta-line"
import { BAR_VALUE_TONE } from "../severity-tokens"
import { FilterSelect } from "./gcp-resources"
import {
	GCP_INFRA_COLUMNS,
	GCP_NAME_SORT,
	formatGcpValue,
	gcpHasRegion,
	gcpInScope,
	gcpWorkloadName,
	gcpWorkloadNoun,
	gcpWorkloadSearch,
	gcpWorkloadTone,
	sortGcpWorkloads,
	type GcpColumn,
	type GcpScope,
	type GcpWorkload,
} from "./tabs"

const NAME_WIDTH = "w-0 flex-1 min-w-[240px]"
const VALUE_WIDTH = "w-[104px]"

/** Every service's workloads by health; each cell narrows the tables to its workloads. */
export function GcpSummaryBand({
	workloads,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: {
	workloads: ReadonlyArray<GcpWorkload>
	activeScope: GcpScope | undefined
	onScopeChange: (scope: GcpScope | undefined) => void
	waiting?: boolean
	className?: string
}) {
	const inScope = (scope: GcpScope) => workloads.filter((workload) => gcpInScope(workload, scope))
	const erroring = inScope("erroring")
	const toned = (tone: "crit" | "warn") =>
		workloads.filter((workload) => gcpWorkloadTone(workload) === tone).length
	return (
		<FleetBand<GcpScope>
			total={workloads.length}
			noun="workload"
			caption="share of workloads by average use of a limit and by error rate"
			segments={[
				{
					key: "healthy",
					count: workloads.length - toned("warn") - toned("crit"),
					className: "bg-muted-foreground/35",
				},
				{ key: "elevated", count: toned("warn"), className: TONE_FILL.warn },
				{ key: "critical", count: toned("crit"), className: TONE_FILL.crit },
			]}
			cells={[
				{
					scope: "saturated",
					label: "Saturated",
					hint: "≥90%",
					value: inScope("saturated").length,
					tone: "crit",
				},
				{
					scope: "elevated",
					label: "Elevated",
					hint: "≥60%",
					value: inScope("elevated").length,
					tone: "warn",
				},
				{
					scope: "erroring",
					label: "Erroring",
					hint: "≥1% failed",
					value: erroring.length,
					tone: erroring.some((workload) => workload.errors === "crit") ? "crit" : "warn",
				},
			]}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			waiting={waiting}
			className={className}
		/>
	)
}

export function GcpSummaryBandLoading({ className }: { className?: string }) {
	return <FleetBandLoading cells={3} className={className} />
}

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
function Columns({ service, sort }: { service: GcpInfraServiceId; sort?: SortControls<string> }) {
	return (
		<>
			<ColumnHead<string>
				label={GCP_INFRA_SERVICES[service].identity[0][0]}
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

/** An error rate and a share of a limit take their severity color; every other number is plain. */
export function gcpValueClass(spec: GcpColumn, value: number | undefined): string {
	if (value !== undefined && spec.format === "errorRate") return errorRateClass(value)
	if (value !== undefined && spec.format === "percent" && utilizationLevel(value) !== "ok") {
		return BAR_VALUE_TONE[utilizationLevel(value)]
	}
	return "text-foreground/80"
}

interface GcpPlaceFilter {
	readonly project?: string | undefined
	readonly region?: string | undefined
}

/**
 * One service's workloads over the window: searchable, filtered by project, region and health
 * scope, sortable by any column. A row opens the workload's page.
 */
export function GcpServiceTable({
	service,
	workloads,
	truncated,
	failed,
	query,
	scope,
	place,
	projects,
	regions,
	onQueryChange,
	onPlaceChange,
	timeSearch,
	waiting,
}: {
	service: GcpInfraServiceId
	/** The service's workloads in the selected project and region. */
	workloads: ReadonlyArray<GcpWorkload>
	/** The tab's query hit its row cap. */
	truncated: boolean
	/** The tab's query failed. */
	failed: boolean
	query: string
	scope: GcpScope | undefined
	place: GcpPlaceFilter
	/** The projects and regions of every service's workloads: the filters' options. */
	projects: ReadonlyArray<string>
	regions: ReadonlyArray<string>
	onQueryChange: (query: string) => void
	onPlaceChange: (place: GcpPlaceFilter) => void
	timeSearch: TimeRangeSearch
	waiting?: boolean
}) {
	const { title, identity } = GCP_INFRA_SERVICES[service]
	const columns = GCP_INFRA_COLUMNS[service]
	const noun = gcpWorkloadNoun(service)
	const { sortKey, sortDir, handleSort } = useSortState<string>({
		initialKey: columns[0].label,
		stringKeys: [GCP_NAME_SORT],
	})

	const needle = query.trim().toLowerCase()
	const shown = useMemo(() => {
		const matching = workloads.filter(
			(workload) =>
				(scope === undefined || gcpInScope(workload, scope)) &&
				(needle === "" || workload.keys.join(" ").toLowerCase().includes(needle)),
		)
		return sortGcpWorkloads(service, matching, { key: sortKey ?? GCP_NAME_SORT, dir: sortDir })
	}, [service, workloads, scope, needle, sortKey, sortDir])
	// The service has workloads (or a place filter hides them), and the search, filters or scope left none.
	const filteredOut =
		shown.length === 0 &&
		!failed &&
		(workloads.length > 0 || place.project !== undefined || place.region !== undefined)

	return (
		<div className="space-y-4">
			<SearchToolbar
				value={query}
				onChange={onQueryChange}
				placeholder={`Search ${title}…`}
				trailing={
					shown.length === workloads.length
						? countLabel(workloads.length, noun)
						: `${shown.length} of ${countLabel(workloads.length, noun)}`
				}
			>
				{projects.length > 1 || place.project !== undefined ? (
					<FilterSelect
						label="Project"
						allLabel="All projects"
						options={projects.map((project) => ({ value: project, label: project }))}
						value={place.project}
						onChange={(project) => onPlaceChange({ ...place, project })}
					/>
				) : null}
				{/* A subscription and a URL map are global: no region to filter them by. */}
				{(gcpHasRegion(service) && regions.length > 1) || place.region !== undefined ? (
					<FilterSelect
						label="Region"
						allLabel="All regions"
						options={regions.map((region) => ({ value: region, label: region }))}
						value={place.region}
						onChange={(region) => onPlaceChange({ ...place, region })}
					/>
				) : null}
			</SearchToolbar>
			{filteredOut ? (
				<FilteredEmpty
					noun={`${noun}s`}
					description="Clear the search, filters or scope to see them all."
				/>
			) : (
				<DataTable.Root ariaLabel={title} waiting={waiting}>
					<DataTable.Head>
						<Columns
							service={service}
							sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }}
						/>
					</DataTable.Head>
					{shown.length === 0 ? (
						<DataTable.Empty>
							{failed
								? `Maple could not read the ${title} metrics. Reload to try again.`
								: `No ${title} metrics in this time range.`}
						</DataTable.Empty>
					) : null}
					{shown.map((workload) => (
						<Link
							key={workload.keys.join("\u0000")}
							to="/infra/gcp/$service/$name"
							params={{ service, name: workload.keys[0] }}
							search={{ ...timeSearch, ...gcpWorkloadSearch(service, workload.keys) }}
							className={ROW_LINK_CLASS}
						>
							<div className={NAME_WIDTH}>
								<div className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary">
									{gcpWorkloadName(service, workload.keys)}
								</div>
								<MetaLine
									items={workload.keys.slice(1)}
									title={identity
										.slice(1)
										.map(([label], index) => `${label}: ${workload.keys[index + 1]}`)
										.join(" · ")}
								/>
							</div>
							{columns.map((spec, index) => (
								<div
									key={spec.label}
									className={cn(
										"text-right font-mono text-xs tabular-nums",
										VALUE_WIDTH,
										gcpValueClass(spec, workload.values[index]),
									)}
								>
									{formatGcpValue(spec.format, workload.values[index])}
								</div>
							))}
						</Link>
					))}
				</DataTable.Root>
			)}
			{truncated ? (
				<p className="text-xs text-muted-foreground">
					This list is cut off: it shows the first workloads by name.
				</p>
			) : null}
		</div>
	)
}
