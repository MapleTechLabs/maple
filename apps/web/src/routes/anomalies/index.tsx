import { useCallback, useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { Schema } from "effect"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { AnomaliesFilterSidebar } from "@/components/anomalies/anomalies-filter-sidebar"
import {
	anomalyFilterChips,
	hasAnomalyFilters,
	matchesAnomalyFilters,
	type AnomalyFilters,
} from "@/lib/anomalies/anomaly-filters"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { ExcludedEmptyHint } from "@maple/ui/components/filters/excluded-empty-hint"
import {
	ANOMALY_GROUP_ORDER,
	AnomalyGroup,
	anomalyGroupKey,
	type AnomalyGroupKey,
} from "@/components/anomalies/anomaly-group"
import { AnomalyLiveIndicator } from "@/components/anomalies/anomaly-live-indicator"
import { ListToolbar } from "@/components/common/list-toolbar"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { runMapleApiV2 } from "@/lib/collections/api-runner"
import { anomalyIncidentFromV2 } from "@/lib/services/anomalies"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Button } from "@maple/ui/components/ui/button"
import { ListFooter } from "@maple/ui/components/ui/list-footer"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import { ErrorState } from "@/components/common/error-state"
import { ConnectionIcon } from "@/components/icons"
import { useSignalPresence } from "@/hooks/use-signal-presence"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import type { AnomalyIncidentDocument, AnomalyIncidentId } from "@maple/domain/http"

const LIVE_REFRESH_INTERVAL_MS = 15_000
// v2 lists cap at 100; further pages arrive through the explicit "Load more".
const INCIDENTS_PAGE_LIMIT = 100

type StatusTab = "open" | "resolved" | "all"

interface LoadedPages {
	readonly key: StatusTab
	readonly rows: ReadonlyArray<AnomalyIncidentDocument>
	readonly nextCursor: string | null
}

const TOOLBAR_TABS: ReadonlyArray<{ value: StatusTab; label: string }> = [
	{ value: "open", label: "Open" },
	{ value: "resolved", label: "Resolved" },
	{ value: "all", label: "All" },
]

const searchSchema = Schema.Struct({
	status: Schema.optional(Schema.Literals(["open", "resolved", "all"])),
	severity: Schema.optional(Schema.Array(Schema.Literals(["warning", "critical"]))),
	signals: Schema.optional(
		Schema.Array(
			Schema.Literals(["error_rate", "latency_p95", "throughput", "error_spike", "log_volume"]),
		),
	),
	services: Schema.optional(Schema.Array(Schema.String)),
	envs: Schema.optional(Schema.Array(Schema.String)),
	excludedSeverity: Schema.optional(Schema.Array(Schema.Literals(["warning", "critical"]))),
	excludedSignals: Schema.optional(
		Schema.Array(
			Schema.Literals(["error_rate", "latency_p95", "throughput", "error_spike", "log_volume"]),
		),
	),
	excludedServices: Schema.optional(Schema.Array(Schema.String)),
	excludedEnvs: Schema.optional(Schema.Array(Schema.String)),
	live: Schema.optional(Schema.Boolean),
})

export const Route = createFileRoute("/anomalies/")({
	component: AnomaliesPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

function AnomaliesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const status: StatusTab = search.status ?? "open"
	const live = search.live ?? status === "open"

	const listQuery = useMemo(
		() => (status === "all" ? { limit: INCIDENTS_PAGE_LIMIT } : { status, limit: INCIDENTS_PAGE_LIMIT }),
		[status],
	)
	// Memoized because `useRefreshableAtomValue` updates state during
	// render when the Result identity changes: a fresh atom per render would
	// feed it a fresh Result every time and never converge.
	const incidentsQueryAtom = useMemo(
		() =>
			retainedQueryV2("anomalies", "listIncidents", {
				query: listQuery,
				reactivityKeys: ["anomalyIncidents"],
			}),
		[listQuery],
	)
	// Retain the previous list across tab switches so the page never collapses
	// back to skeletons; live refresh ticks keep the same atom and never dim.
	const incidentsResult = useRefreshableAtomValue(incidentsQueryAtom)
	const refreshFirstPage = useAtomRefresh(incidentsQueryAtom)

	// Pages loaded past the first. Keyed by the tab they were fetched for, so a
	// tab switch discards them without an effect; a refresh clears them outright,
	// otherwise the live tick would leave stale rows below fresh ones.
	const [loadedPages, setLoadedPages] = useState<LoadedPages | null>(null)
	const pages = loadedPages?.key === status ? loadedPages : null

	const refreshIncidents = useCallback(() => {
		setLoadedPages(null)
		refreshFirstPage()
	}, [refreshFirstPage])

	useIntervalRefresh(refreshIncidents, {
		intervalMs: LIVE_REFRESH_INTERVAL_MS,
		enabled: live,
	})

	const filters: AnomalyFilters = useMemo(
		() => ({
			severity: search.severity,
			signals: search.signals,
			services: search.services,
			envs: search.envs,
			excludedSeverity: search.excludedSeverity,
			excludedSignals: search.excludedSignals,
			excludedServices: search.excludedServices,
			excludedEnvs: search.excludedEnvs,
		}),
		[
			search.severity,
			search.signals,
			search.services,
			search.envs,
			search.excludedSeverity,
			search.excludedSignals,
			search.excludedServices,
			search.excludedEnvs,
		],
	)

	const updateFilter = useCallback(
		<K extends keyof AnomalyFilters>(key: K, value: AnomalyFilters[K]) => {
			navigate({ search: (prev) => ({ ...prev, [key]: value }) })
		},
		[navigate],
	)

	const clearFilters = useCallback(() => {
		navigate({
			search: (prev) => ({
				status: prev.status,
				live: prev.live,
			}),
		})
	}, [navigate])

	const firstPage = Result.isSuccess(incidentsResult) ? incidentsResult.value : undefined
	const allIncidents = useMemo(() => {
		const firstPageIncidents = firstPage?.data.map(anomalyIncidentFromV2) ?? []
		if (pages === null) return firstPageIncidents
		const byId = new Map(firstPageIncidents.map((incident) => [incident.id, incident]))
		for (const incident of pages.rows) if (!byId.has(incident.id)) byId.set(incident.id, incident)
		return [...byId.values()]
	}, [firstPage, pages])

	const nextCursor = pages === null ? (firstPage?.next_cursor ?? null) : pages.nextCursor

	const [runLoadMore, loadingMore] = useAsyncAction((cursor: string) =>
		runMapleApiV2((client) => client.anomalies.listIncidents({ query: { ...listQuery, cursor } })).then(
			(page) => {
				const rows = page.data.map(anomalyIncidentFromV2)
				setLoadedPages((current) => ({
					key: status,
					rows: [...(current?.key === status ? current.rows : []), ...rows],
					nextCursor: page.next_cursor,
				}))
			},
			() => {
				toastManager.add({ title: "More anomalies could not be loaded", type: "error" })
			},
		),
	)
	const loadMore = () => {
		if (nextCursor === null || loadingMore) return
		void runLoadMore(nextCursor)
	}

	const filtered = useMemo(
		() => allIncidents.filter((incident) => matchesAnomalyFilters(incident, filters)),
		[allIncidents, filters],
	)

	const hasActiveFilters = hasAnomalyFilters(filters)

	const excludedChips = anomalyFilterChips(filters).filter((chip) => chip.negated)
	const excludedValues = excludedChips.flatMap((chip) => chip.values)
	const clearExclusions = () =>
		navigate({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(excludedChips.map((chip) => [chip.param, undefined])),
			}),
		})

	const activeFilterChips = anomalyFilterChips(filters).map((chip) => ({
		id: chip.param,
		label: chip.label,
		values: chip.values,
		negated: chip.negated,
		onRemove: () => navigate({ search: (prev) => ({ ...prev, [chip.param]: undefined }) }),
	}))

	// Folded into the toolbar node rather than placed per-branch: the three Result branches each
	// render `toolbar`, and a chip bar that appeared only on success would vanish on every refresh.
	const toolbar = (
		<>
			<ListToolbar
				tabs={TOOLBAR_TABS}
				active={status}
				label="Filter anomalies"
				countNoun={["anomaly", "anomalies"]}
				totalCount={Result.isSuccess(incidentsResult) ? filtered.length : undefined}
				onChange={(value) =>
					navigate({
						search: (prev) => ({
							...prev,
							status: value === "open" ? undefined : value,
						}),
					})
				}
			/>
			<ActiveFilterChips
				chips={activeFilterChips}
				onClearAll={clearFilters}
				className="mb-0 px-2 pb-2"
			/>
		</>
	)

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Anomalies" }]}
			filters={
				<AnomaliesFilterSidebar
					incidents={allIncidents}
					filters={filters}
					onChange={updateFilter}
					onClear={clearFilters}
				/>
			}
			headerActions={
				<AnomalyLiveIndicator
					live={live}
					onToggle={(next) =>
						navigate({
							search: (prev) => ({
								...prev,
								live: next === (status === "open") ? undefined : next,
							}),
						})
					}
				/>
			}
		>
			<div>
				{toolbar}
				{Result.builder(incidentsResult)
					.onInitial(() => <SkeletonList rows={5} rowClassName="h-9" className="p-2" />)
					.onError((error) => (
						<div className="p-4">
							<ErrorState
								error={error}
								title="Failed to load anomalies"
								onRetry={refreshIncidents}
							/>
						</div>
					))
					.onSuccess(() => (
						<AnomaliesPageBody
							incidents={filtered}
							status={status}
							hasActiveFilters={hasActiveFilters}
							onClearFilters={clearFilters}
							excludedValues={excludedValues}
							onClearExclusions={clearExclusions}
							hasMore={nextCursor !== null}
							loadingMore={loadingMore}
							onLoadMore={loadMore}
						/>
					))
					.render()}
			</div>
		</DashboardPage>
	)
}

function AnomaliesPageBody({
	incidents,
	status,
	hasActiveFilters,
	onClearFilters,
	excludedValues,
	onClearExclusions,
	hasMore,
	loadingMore,
	onLoadMore,
}: {
	incidents: ReadonlyArray<AnomalyIncidentDocument>
	status: StatusTab
	hasActiveFilters: boolean
	onClearFilters: () => void
	/** Flattened active exclusions, for the empty state's hint. */
	excludedValues: ReadonlyArray<string>
	onClearExclusions: () => void
	hasMore: boolean
	loadingMore: boolean
	onLoadMore: () => void
}) {
	const navigate = useNavigate({ from: Route.fullPath })
	const tracePresence = useSignalPresence("traces")

	const grouped = useMemo(() => {
		const map = new Map<AnomalyGroupKey, AnomalyIncidentDocument[]>()
		for (const incident of incidents) {
			const key = anomalyGroupKey(incident)
			const bucket = map.get(key) ?? []
			bucket.push(incident)
			map.set(key, bucket)
		}
		// Cluster each bucket by service+env so the anomalies one event produces
		// (error-frequency, error-rate, and log-volume changes on one service) sit together;
		// clusters order by their freshest incident, rows within by recency.
		for (const bucket of map.values()) {
			const clusterKey = (i: AnomalyIncidentDocument) => `${i.serviceName}\u0000${i.deploymentEnv}`
			const latestByCluster = new Map<string, string>()
			for (const incident of bucket) {
				const key = clusterKey(incident)
				const latest = latestByCluster.get(key)
				if (latest === undefined || incident.lastTriggeredAt.localeCompare(latest) > 0) {
					latestByCluster.set(key, incident.lastTriggeredAt)
				}
			}
			bucket.sort((a, b) => {
				const clusterA = latestByCluster.get(clusterKey(a))!
				const clusterB = latestByCluster.get(clusterKey(b))!
				if (clusterA !== clusterB) return clusterB.localeCompare(clusterA)
				const keyCompare = clusterKey(a).localeCompare(clusterKey(b))
				if (keyCompare !== 0) return keyCompare
				return b.lastTriggeredAt.localeCompare(a.lastTriggeredAt)
			})
		}
		return map
	}, [incidents])

	const visibleGroups = useMemo(
		() => ANOMALY_GROUP_ORDER.filter((key) => (grouped.get(key)?.length ?? 0) > 0),
		[grouped],
	)

	const flatIds = useMemo(() => {
		const out: string[] = []
		for (const key of visibleGroups) {
			for (const incident of grouped.get(key) ?? []) out.push(incident.id)
		}
		return out
	}, [grouped, visibleGroups])

	const { focusedId, setFocusedId } = useListNavigation({
		ids: flatIds,
		onOpen: (id) => {
			navigate({
				to: "/anomalies/$incidentId",
				params: { incidentId: id as AnomalyIncidentId },
			})
		},
		scrollTo: (id) => scrollIntoView(id),
	})

	return incidents.length === 0 ? (
		<div className="p-4">
			<Empty>
				<EmptyHeader>
					<EmptyTitle>
						{hasActiveFilters
							? "No anomalies match the current filters"
							: status === "open"
								? "No open anomalies"
								: "No anomalies"}
					</EmptyTitle>
					<EmptyDescription>
						{hasActiveFilters
							? "Try widening or clearing the filters."
							: "The detector compares every service's error rate, latency, throughput, error fingerprints, and log volume against its own 7-day baseline. Incidents appear here when something deviates."}
						{!hasActiveFilters && tracePresence.status === "absent"
							? " Anomaly detection learns a baseline from your traces and logs. Send telemetry to start."
							: null}
					</EmptyDescription>
				</EmptyHeader>
				{hasActiveFilters ? (
					<Button variant="outline" size="sm" onClick={onClearFilters}>
						Clear filters
					</Button>
				) : tracePresence.status === "absent" ? (
					<EmptyContent>
						<EmptyActions>
							<Button
								size="sm"
								className="gap-2"
								render={<Link to="/settings" search={{ tab: "ingestion" }} />}
							>
								<ConnectionIcon size={14} />
								Set up tracing
							</Button>
							<DocsLink page="instrumentation">Setup guide</DocsLink>
						</EmptyActions>
					</EmptyContent>
				) : tracePresence.status === "present" ? (
					<EmptyContent>
						<EmptyActions>
							<Button variant="outline" size="sm" render={<Link to="/alerts/create" />}>
								Create an alert rule
							</Button>
							<DocsLink page="alertRules">Alert rules</DocsLink>
						</EmptyActions>
					</EmptyContent>
				) : null}
				{/* Named separately from "Clear filters": an inclusion is visible in what
				    came back, an exclusion only in what did not. */}
				<ExcludedEmptyHint
					excluded={excludedValues}
					onClear={onClearExclusions}
					className="max-w-lg"
				/>
			</Empty>
		</div>
	) : (
		<div>
			{visibleGroups.map((key) => (
				<AnomalyGroup
					key={key}
					group={key}
					incidents={grouped.get(key) ?? []}
					focusedId={focusedId}
					onFocus={setFocusedId}
				/>
			))}
			{hasMore ? (
				<ListFooter hasMore loading={loadingMore} onLoadMore={onLoadMore} className="p-4" />
			) : null}
		</div>
	)
}

function scrollIntoView(incidentId: string) {
	if (typeof document === "undefined") return
	const el = document.querySelector<HTMLElement>(`[data-incident-id="${CSS.escape(incidentId)}"]`)
	if (!el) return
	el.scrollIntoView({ block: "nearest", behavior: "smooth" })
}
