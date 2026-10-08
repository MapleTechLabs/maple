import { GCP_PROJECT_ASSET_TYPE } from "@maple/domain/gcp-metrics"
import type { GcpResourcesResponse } from "@maple/domain/http"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { EMPTY_VALUE, countLabel } from "@maple/ui/lib/format"

import { ColumnHead, DataTable, MetaChip } from "@/components/common/data-table"
import { ResultView } from "@/components/common/result-view"
import { CircleWarningIcon } from "@/components/icons"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

import { gcpAssetTypeLabel, gcpResourceName } from "./tabs"

export interface GcpResourceFilter {
	readonly type?: string | undefined
	readonly project?: string | undefined
}

const ALL = "all"
const MAX_LABELS = 3

function FilterSelect({
	label,
	allLabel,
	options,
	value,
	onChange,
}: {
	label: string
	allLabel: string
	options: ReadonlyArray<{ value: string; label: string }>
	value: string | undefined
	onChange: (value: string | undefined) => void
}) {
	const items = [{ value: ALL, label: allLabel }, ...options]
	return (
		<Select
			items={items}
			value={value ?? ALL}
			onValueChange={(next) => {
				const picked = items.find((item) => item.value === next)?.value
				onChange(picked === undefined || picked === ALL ? undefined : picked)
			}}
		>
			<SelectTrigger size="sm" className="w-auto min-w-0 text-xs" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function Columns() {
	return (
		<>
			<ColumnHead label="Resource" width="w-0 flex-1 min-w-[220px]" />
			<ColumnHead label="Type" width="w-[170px]" />
			<ColumnHead label="Project" width="w-[170px]" />
			<ColumnHead label="Location" width="w-[130px]" />
			<ColumnHead label="State" width="w-[100px]" />
			<ColumnHead label="Labels" width="w-[260px]" hidden="hidden lg:flex" />
		</>
	)
}

const CELL = "truncate font-mono text-xs text-foreground/80"

function Resources({
	inventory,
	filter,
	onFilterChange,
	waiting,
}: {
	inventory: GcpResourcesResponse
	filter: GcpResourceFilter
	onFilterChange: (filter: GcpResourceFilter) => void
	waiting: boolean
}) {
	const { resources, total, types, projects } = inventory
	const projectCount = types.find((entry) => entry.assetType === GCP_PROJECT_ASSET_TYPE)?.count ?? 0
	const filtered = filter.type !== undefined || filter.project !== undefined

	return (
		<>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<FilterSelect
						label="Resource type"
						allLabel="All types"
						options={types.map((entry) => ({
							value: entry.assetType,
							label: `${gcpAssetTypeLabel(entry.assetType)} (${entry.count})`,
						}))}
						value={filter.type}
						onChange={(type) => onFilterChange({ ...filter, type })}
					/>
					<FilterSelect
						label="Project"
						allLabel="All projects"
						options={projects.map((project) => ({ value: project, label: project }))}
						value={filter.project}
						onChange={(project) => onFilterChange({ ...filter, project })}
					/>
				</div>
				<span className="text-xs text-muted-foreground tabular-nums">
					{total > resources.length
						? `First ${resources.length} of ${countLabel(total, "resource")}`
						: countLabel(total, "resource")}
					{" · "}
					{countLabel(projectCount, "project")} discovered
				</span>
			</div>
			<DataTable.Root ariaLabel="Google Cloud resources" waiting={waiting}>
				<DataTable.Head>
					<Columns />
				</DataTable.Head>
				{resources.length === 0 ? (
					<DataTable.Empty>
						{filtered
							? "No resources match these filters."
							: "No resources yet. Maple lists a connection's resources every hour."}
					</DataTable.Empty>
				) : null}
				{resources.map((resource) => {
					const labels = Object.entries(resource.labels)
					return (
						<div
							key={`${resource.assetType}:${resource.name}`}
							className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"
						>
							<div
								className="w-0 min-w-[220px] flex-1 truncate font-mono text-xs font-medium text-foreground"
								title={resource.name}
							>
								{gcpResourceName(resource)}
							</div>
							<div className="w-[170px] truncate text-xs text-foreground/80">
								{gcpAssetTypeLabel(resource.assetType)}
							</div>
							<div className={`w-[170px] ${CELL}`}>{resource.projectId}</div>
							<div className={`w-[130px] ${CELL}`}>{resource.location ?? EMPTY_VALUE}</div>
							<div className={`w-[100px] ${CELL}`}>{resource.state ?? EMPTY_VALUE}</div>
							<div
								className="hidden w-[260px] items-center gap-2 overflow-hidden lg:flex"
								title={labels.map(([key, value]) => `${key}: ${value}`).join("\n")}
							>
								{labels.slice(0, MAX_LABELS).map(([key, value]) => (
									<MetaChip key={key}>
										{key}: {value}
									</MetaChip>
								))}
								{labels.length > MAX_LABELS ? (
									<MetaChip>+{labels.length - MAX_LABELS}</MetaChip>
								) : null}
							</div>
						</div>
					)
				})}
			</DataTable.Root>
		</>
	)
}

/** The resource inventory of the org's Google Cloud connections, filtered by type and project. */
export function GcpResources({
	filter,
	onFilterChange,
	syncError,
}: {
	filter: GcpResourceFilter
	onFilterChange: (filter: GcpResourceFilter) => void
	/** Why the latest inventory sync was incomplete, if it was. */
	syncError: string | null
}) {
	const result = useRefreshableAtomValue(
		retainedInternalQuery("integrations", "gcpResources", {
			query: { assetType: filter.type, projectId: filter.project },
			reactivityKeys: ["gcpResources"],
		}),
	)

	return (
		<div className="space-y-4">
			{syncError === null ? null : (
				<Alert variant="warn">
					<CircleWarningIcon size={16} />
					<AlertTitle>The latest resource sync was incomplete</AlertTitle>
					<AlertDescription>{syncError}</AlertDescription>
				</Alert>
			)}
			<ResultView
				result={result}
				loading={
					<DataTable.Root ariaLabel="Google Cloud resources">
						<DataTable.Head>
							<Columns />
						</DataTable.Head>
						<DataTable.SkeletonRows count={5}>
							<Skeleton className="h-4 w-0 min-w-[220px] flex-1" />
							<Skeleton className="h-3 w-[170px]" />
							<Skeleton className="h-3 w-[170px]" />
							<Skeleton className="h-3 w-[130px]" />
							<Skeleton className="h-3 w-[100px]" />
							<Skeleton className="hidden h-3 w-[260px] lg:block" />
						</DataTable.SkeletonRows>
					</DataTable.Root>
				}
			>
				{(inventory, { waiting }) => (
					<Resources
						inventory={inventory}
						filter={filter}
						onFilterChange={onFilterChange}
						waiting={waiting}
					/>
				)}
			</ResultView>
		</div>
	)
}
