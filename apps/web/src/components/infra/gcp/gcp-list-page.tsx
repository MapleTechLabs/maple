// The /infra/gcp list as one presentational page: header, projects strip, and the current view's
// band, search and table. The route fetches and owns the URL; the lab renders the same component
// from fixtures.

import { useDeferredValue, useMemo, type ReactNode } from "react"

import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"

import { HeroChip, PageHero } from "@/components/common/page-hero"
import { SearchToolbar } from "@/components/common/search-toolbar"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { FilterChipRail } from "../primitives/filter-chips"
import { SegmentPivot } from "../primitives/segment-pivot"
import {
	GCP_DATABASE_BAND,
	GCP_SERVICE_BAND,
	GCP_SUBSCRIPTION_BAND,
	GcpBand,
	GcpBandLoading,
	gcpWorkloadBand,
	type GcpBandSpec,
} from "./gcp-bands"
import { GcpDatabasesTable, GcpServicesTable, GcpSubscriptionsTable } from "./gcp-list-tables"
import { GcpProjectMenu, GcpProjectsStrip } from "./gcp-projects-ui"
import { GcpServiceTable, GcpServiceTableLoading } from "./gcp-service-table"
import type { GcpCloudSqlInstance } from "./inventory"
import {
	GCP_DATABASE_RULES,
	GCP_SERVICE_RULES,
	GCP_SUBSCRIPTION_RULES,
	GCP_WORKLOAD_RULES,
	gcpListRows,
	gcpListScope,
	gcpProjectCounts,
	gcpProjectShares,
	gcpViewFailed,
	sortByAttention,
	type GcpFleetRead,
	type GcpGenericView,
	type GcpProjectHealth,
	type GcpSparks,
	type RowRules,
} from "./list-model"
import { GCP_RESOURCES_TAB, GCP_VIEW_SERVICES, type GcpServiceView, type GcpView } from "./tabs"

export interface GcpListState {
	view?: GcpView
	q?: string
	/** One of the current view's band cells. */
	scope?: string
	/** One project; absent means all of them. */
	project?: string
	region?: string
}

const VIEW_LABEL = {
	services: "Services",
	pubsub: "Pub/Sub",
	cloudSql: "Cloud SQL",
	gke: "GKE",
	computeEngine: "Compute Engine",
	loadBalancing: "Load Balancing",
	resources: "Resources",
} as const satisfies Record<GcpView, string>

/** A view's rows in running text, plural. */
const ROWS_NOUN = {
	services: "services",
	pubsub: "subscriptions",
	cloudSql: "instances",
	gke: "containers",
	computeEngine: "VMs",
	loadBalancing: "URL maps",
} as const satisfies Record<GcpServiceView, string>

const GENERIC_BAND = {
	gke: gcpWorkloadBand("container"),
	computeEngine: gcpWorkloadBand("VM"),
	loadBalancing: gcpWorkloadBand("URL map"),
} as const satisfies Record<GcpGenericView, unknown>

export function GcpListPage({
	fleet,
	sparks,
	cloudSqlInstances,
	projectHealth,
	collecting,
	notice,
	resources,
	state,
	onStateChange,
	timeSearch,
	waiting = false,
}: {
	/** Null while loading. */
	fleet: ReadonlyArray<GcpFleetRead> | null
	/** The current view's sparklines; empty until they load. */
	sparks: GcpSparks
	/** The Cloud SQL inventory, read while that view shows: names an instance's engine and limits. */
	cloudSqlInstances?: ReadonlyArray<GcpCloudSqlInstance>
	projectHealth: ReadonlyMap<string, GcpProjectHealth>
	/** A connection collects: the inventory is listed. */
	collecting: boolean
	/** What the connections say, above the lists. */
	notice?: ReactNode
	/** The Resources view, which reads the inventory itself. */
	resources?: ReactNode
	state: GcpListState
	onStateChange: (patch: Partial<GcpListState>) => void
	timeSearch: TimeRangeSearch
	waiting?: boolean
}) {
	const allRows = useMemo(
		() => (fleet === null ? null : gcpListRows(fleet, sparks, cloudSqlInstances)),
		[fleet, sparks, cloudSqlInstances],
	)
	const { projects, project, region, inRegion, rows, counts, views, view } = useMemo(
		() =>
			gcpListScope(
				allRows,
				{ view: state.view, project: state.project, region: state.region },
				collecting,
			),
		[allRows, state.view, state.project, state.region, collecting],
	)
	const multiProject = projects.length > 1
	const projectCounts = (name: string) => gcpProjectCounts(inRegion, name, view)
	const setProject = (next: string | undefined) => onStateChange({ project: next, scope: undefined })

	const section = (body: ReactNode) => (
		<div className={cn("space-y-4", refreshingClass(waiting))} aria-busy={waiting || undefined}>
			{body}
		</div>
	)
	const listProps = {
		query: state.q ?? "",
		region,
		onQueryChange: (q: string) => onStateChange({ q: q || undefined }),
		onScopeChange: (scope: string | undefined) => onStateChange({ scope }),
		onRegionClear: () => onStateChange({ region: undefined, scope: undefined }),
	}
	const tableProps = { timeSearch, showProject: multiProject && project === undefined }

	const body = (): ReactNode => {
		if (view === GCP_RESOURCES_TAB) return resources
		if (fleet === null) {
			return section(
				<>
					<GcpBandLoading />
					<GcpServiceTableLoading service={GCP_VIEW_SERVICES[view][0]} />
				</>,
			)
		}
		const failed = gcpViewFailed(fleet, view)
		switch (view) {
			case "services":
				return section(
					<ListBody
						{...listProps}
						rows={rows.services}
						rules={GCP_SERVICE_RULES}
						spec={GCP_SERVICE_BAND}
						scope={state.scope}
						noun={ROWS_NOUN.services}
						title="Cloud Run or Cloud Functions"
						failed={failed}
						render={(shown, emptyMessage) => (
							<GcpServicesTable rows={shown} emptyMessage={emptyMessage} {...tableProps} />
						)}
					/>,
				)
			case "pubsub":
				return section(
					<ListBody
						{...listProps}
						rows={rows.pubsub}
						rules={GCP_SUBSCRIPTION_RULES}
						spec={GCP_SUBSCRIPTION_BAND}
						scope={state.scope}
						noun={ROWS_NOUN.pubsub}
						title="Pub/Sub"
						failed={failed}
						render={(shown, emptyMessage) => (
							<GcpSubscriptionsTable rows={shown} emptyMessage={emptyMessage} {...tableProps} />
						)}
					/>,
				)
			case "cloudSql":
				return section(
					<ListBody
						{...listProps}
						rows={rows.cloudSql}
						rules={GCP_DATABASE_RULES}
						spec={GCP_DATABASE_BAND}
						scope={state.scope}
						noun={ROWS_NOUN.cloudSql}
						order="closest to a limit first"
						title="Cloud SQL"
						failed={failed}
						render={(shown, emptyMessage) => (
							<GcpDatabasesTable rows={shown} emptyMessage={emptyMessage} {...tableProps} />
						)}
					/>,
				)
			default:
				return section(
					<ListBody
						{...listProps}
						rows={rows[view]}
						rules={GCP_WORKLOAD_RULES}
						spec={GENERIC_BAND[view]}
						scope={state.scope}
						noun={ROWS_NOUN[view]}
						title={VIEW_LABEL[view]}
						failed={failed}
						render={(shown, emptyMessage) => (
							<GcpServiceTable
								service={view}
								rows={shown}
								spec={GENERIC_BAND[view]}
								emptyMessage={emptyMessage}
								timeSearch={timeSearch}
							/>
						)}
					/>,
				)
		}
	}

	return (
		<div className="space-y-6">
			<PageHero
				title="Google Cloud"
				trailing={
					multiProject ? (
						<GcpProjectMenu
							projects={projects}
							counts={projectCounts}
							health={projectHealth}
							value={project}
							onChange={setProject}
						/>
					) : projects.length === 1 ? (
						<HeroChip>project {projects[0]}</HeroChip>
					) : null
				}
				actions={
					views.length > 1 ? (
						<SegmentPivot<GcpView>
							ariaLabel="Google Cloud view"
							options={views.map((option) => ({
								value: option,
								label:
									option === GCP_RESOURCES_TAB || counts === null
										? VIEW_LABEL[option]
										: `${VIEW_LABEL[option]} ${counts[option]}`,
							}))}
							value={view}
							onChange={(next) => onStateChange({ view: next, scope: undefined, q: undefined })}
						/>
					) : null
				}
			/>
			{notice}
			{multiProject && project === undefined && view !== GCP_RESOURCES_TAB ? (
				<GcpProjectsStrip
					projects={projects}
					share={gcpProjectShares(inRegion, view)}
					counts={projectCounts}
					health={projectHealth}
					onSelect={setProject}
				/>
			) : null}
			{body()}
		</div>
	)
}

/** One view's band, search and table. The band counts every row; the table shows what is left. */
function ListBody<R extends { readonly keys: ReadonlyArray<string> }, S extends string>({
	rows,
	rules,
	spec,
	scope: requestedScope,
	query,
	region,
	noun,
	order = "problems first",
	title,
	failed,
	onQueryChange,
	onScopeChange,
	onRegionClear,
	render,
}: {
	rows: ReadonlyArray<R>
	rules: RowRules<R, S>
	spec: GcpBandSpec<S>
	scope: string | undefined
	query: string
	region: string | undefined
	/** Plural. */
	noun: string
	order?: string
	/** What the rows come from, for the empty states. */
	title: string
	failed: boolean
	onQueryChange: (query: string) => void
	onScopeChange: (scope: S | undefined) => void
	onRegionClear: () => void
	render: (rows: ReadonlyArray<R>, emptyMessage: string) => ReactNode
}) {
	const scope = rules.scopes.find((candidate) => candidate === requestedScope)
	const needle = useDeferredValue(query).trim().toLowerCase()
	const shown = useMemo(
		() =>
			sortByAttention(
				rules,
				rows.filter(
					(row) =>
						(scope === undefined || rules.inScope(row, scope)) &&
						(needle === "" || row.keys.join(" ").toLowerCase().includes(needle)),
				),
			),
		[rules, rows, scope, needle],
	)
	const emptyMessage = failed
		? `Maple could not read the ${title} metrics. Reload to try again.`
		: rows.length === 0
			? `No ${title} metrics in this time range.`
			: `No ${noun} match. Clear the search or scope.`
	return (
		<>
			<GcpBand
				rows={rows}
				rules={rules}
				spec={spec}
				activeScope={scope}
				onScopeChange={onScopeChange}
			/>
			<SearchToolbar
				value={query}
				onChange={onQueryChange}
				placeholder={`Filter ${rows.length} ${noun}`}
				trailing={
					shown.length === rows.length
						? `${rows.length} ${noun} · ${order}`
						: `${shown.length} of ${rows.length} ${noun}`
				}
			>
				{region === undefined ? null : (
					<FilterChipRail
						chips={[{ key: "region", value: region, label: `region ${region}` }]}
						onRemove={onRegionClear}
						onClear={onRegionClear}
					/>
				)}
			</SearchToolbar>
			{render(shown, emptyMessage)}
		</>
	)
}
