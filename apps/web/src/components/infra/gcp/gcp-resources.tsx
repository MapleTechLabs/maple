import { GCP_PROJECT_ASSET_TYPE } from "@maple/domain/gcp-metrics"
import type { GcpResourcesResponse } from "@maple/domain/http"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { EMPTY_VALUE, countLabel } from "@maple/ui/lib/format"

import { ColumnHead, DataTable, MetaChip } from "@/components/common/data-table"
import { ResultView } from "@/components/common/result-view"
import { CircleWarningIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { GcpMessage } from "@/components/integrations/gcp-integration-card"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

import { gcpAssetTypeLabel, gcpResourceName } from "./tabs"

export interface GcpResourceFilter {
	readonly type?: string | undefined
	readonly project?: string | undefined
}

const ALL = "all"
/** Re-reads while the inventory is empty, so the first sync shows up without a reload. */
const EMPTY_REFRESH_MS = 30_000

/** "RUNNING" and "PENDING_CREATE" as Google reports them, in the table's own case. */
const stateLabel = (state: string) => (state.charAt(0) + state.slice(1).toLowerCase()).replaceAll("_", " ")

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
			{/* Opens below the trigger: aligned to its item, a long list covers the sidebar. */}
			<SelectContent alignItemWithTrigger={false}>
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
			<ColumnHead label="Project" width="w-[220px]" />
			<ColumnHead label="Location" width="w-[120px]" />
			<ColumnHead label="State" width="w-[120px]" />
			<ColumnHead label="Labels" width="w-[170px]" hidden="hidden lg:flex" />
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
					const labels = Object.entries(resource.labels).map(([key, value]) => `${key}: ${value}`)
					const type = gcpAssetTypeLabel(resource.assetType)
					const state = resource.state === null ? null : stateLabel(resource.state)
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
							<div className="w-[170px] truncate text-xs text-foreground/80" title={type}>
								{type}
							</div>
							<div className={`w-[220px] ${CELL}`} title={resource.projectId}>
								{resource.projectId}
							</div>
							<div className={`w-[120px] ${CELL}`} title={resource.location ?? undefined}>
								{resource.location ?? EMPTY_VALUE}
							</div>
							<div
								className="w-[120px] truncate text-xs text-foreground/80"
								title={state ?? undefined}
							>
								{state ?? EMPTY_VALUE}
							</div>
							{/* One line: the first label, and how many more the tooltip lists. */}
							<div
								className="hidden w-[170px] items-center gap-2 whitespace-nowrap lg:flex"
								title={labels.join("\n")}
							>
								{labels.length === 0 ? null : (
									<span className="min-w-0 truncate">
										<MetaChip>{labels[0]}</MetaChip>
									</span>
								)}
								{labels.length > 1 ? <MetaChip>+{labels.length - 1}</MetaChip> : null}
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
	// Keyed like the connector status, so changing or removing a connection re-reads it.
	const query = retainedInternalQuery("integrations", "gcpResources", {
		query: { assetType: filter.type, projectId: filter.project },
		reactivityKeys: ["gcpIntegration"],
	})
	const result = useRefreshableAtomValue(query)
	const empty = Result.builder(result)
		.onSuccess((inventory) => inventory.types.length === 0)
		.orElse(() => false)
	useIntervalRefresh(useAtomRefresh(query), { intervalMs: EMPTY_REFRESH_MS, enabled: empty })

	return (
		<div className="space-y-4">
			{syncError === null ? null : (
				<Alert variant="warn">
					<CircleWarningIcon size={16} />
					<AlertTitle>The resource list is incomplete</AlertTitle>
					<AlertDescription>
						<GcpMessage text={syncError} />
					</AlertDescription>
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
							<Skeleton className="h-3 w-[220px]" />
							<Skeleton className="h-3 w-[120px]" />
							<Skeleton className="h-3 w-[120px]" />
							<Skeleton className="hidden h-3 w-[170px] lg:block" />
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
