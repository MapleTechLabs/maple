import { useMemo, type ComponentProps } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"

import { PageHero } from "@/components/common/page-hero"
import { ResultView } from "@/components/common/result-view"
import { CircleInfoIcon, CircleWarningIcon, GoogleCloudIcon } from "@/components/icons"
import { GcpListPage, type GcpListState } from "@/components/infra/gcp/gcp-list-page"
import { GcpResources } from "@/components/infra/gcp/gcp-resources"
import { GCP_CLOUD_SQL_INVENTORY_QUERY, gcpCloudSqlInstances } from "@/components/infra/gcp/inventory"
import {
	NO_GCP_SPARKS,
	gcpListRows,
	gcpListScope,
	gcpProjectHealth,
	gcpRequestedView,
	gcpSparklineBucketSeconds,
	gcpSparklineServices,
	gcpSparks,
} from "@/components/infra/gcp/list-model"
import {
	gcpInfraNotice,
	gcpInfraSetupPending,
	gcpResourcesError,
	type GcpInfraNotice,
} from "@/components/infra/gcp/tabs"
import { IntegrationNotConnected } from "@/components/infra/primitives/integration-not-connected"
import { gcpMetricsState } from "@/components/integrations/gcp-connector-state"
import { GcpMessage } from "@/components/integrations/gcp-integration-card"
import { gcpStatusQuery } from "@/components/integrations/integration-catalog"
import { DashboardPage } from "@/components/layout/dashboard-page"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import type { TimeRange } from "@/components/time-range-picker/types"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useLiveClock } from "@/hooks/use-live-clock"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	gcpInfraFleetResultAtom,
	gcpInfraSparklinesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

// Plain strings: a stale or mistyped link falls back to the first view instead of the error page.
const gcpSearchSchema = Schema.Struct({
	/** The list: see `GCP_VIEWS`. */
	view: Schema.optional(Schema.String),
	/** A link from before the views, which named a service: read as its view. */
	tab: Schema.optional(Schema.String),
	/** One of the view's band cells. */
	scope: Schema.optional(Schema.String),
	/** Every view: the project. Lists: the region and a name search. */
	project: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	/** Resources view: the asset type. */
	type: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

type GcpSearchParams = Schema.Schema.Type<typeof gcpSearchSchema>

export const Route = createFileRoute("/infra/gcp/")({
	component: GcpPage,
	validateSearch: Schema.toStandardSchemaV1(gcpSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const DEFAULT_PRESET = "1h"

function GcpPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const statusResult = useAtomValue(gcpStatusQuery())
	const refreshStatus = useAtomRefresh(gcpStatusQuery())
	const nowMs = useLiveClock()
	// While a connection waits on its script or its first read, the page follows it without a reload.
	const settling = Result.builder(statusResult)
		.onSuccess((status) =>
			status.connectors.some((connector) => {
				const kind = gcpMetricsState(connector, nowMs).kind
				return kind === "setup-pending" || kind === "setup-running" || kind === "waiting"
			}),
		)
		.orElse(() => false)
	// A healthy connection is followed too: its states turn on the clock, so a status read once
	// would age into "stalled" on a page left open.
	const connected = Result.builder(statusResult)
		.onSuccess((status) => status.connectors.length > 0)
		.orElse(() => false)
	useIntervalRefresh(refreshStatus, {
		intervalMs: settling ? SETTLING_REFRESH_MS : STEADY_REFRESH_MS,
		enabled: connected,
		catchUp: true,
	})

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: "Google Cloud" }]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			gap="lg"
		>
			{/* The list draws its own header. */}
			{Result.isSuccess(statusResult) ? null : <GcpHero />}
			<ResultView
				result={statusResult}
				loading={<Skeleton className="h-64 w-full" />}
				errorTitle="Failed to load the Google Cloud integration"
				onRetry={refreshStatus}
			>
				{(status) => {
					if (status.connectors.length === 0) {
						return (
							<>
								<GcpHero />
								<IntegrationNotConnected
									icon={<GoogleCloudIcon size={16} />}
									title="Connect Google Cloud to see your infrastructure"
									description="Connect an organization, folder or project that collects metrics and resources. Maple reads Cloud Monitoring metrics and lists your resources, with no agents to install."
									integration="gcp"
									actionLabel="Connect Google Cloud"
									docsPage="gcp"
								/>
							</>
						)
					}
					// None when metrics are switched off everywhere: what was collected before still shows.
					const connectors = status.connectors.filter((connector) => connector.metrics_enabled)
					if (connectors.length > 0 && gcpInfraSetupPending(connectors, nowMs)) {
						return (
							<>
								<GcpHero />
								<IntegrationNotConnected
									icon={<GoogleCloudIcon size={16} />}
									title="Finish setting up Google Cloud"
									description="Metrics and resources are on, but the setup script hasn't run yet."
									integration="gcp"
									actionLabel="Open the integration"
									docsPage="gcp"
								/>
							</>
						)
					}
					return (
						<GcpInfra
							connectors={connectors}
							nowMs={nowMs}
							search={search}
							startTime={startTime}
							endTime={endTime}
							onSearchChange={(patch) =>
								navigate({ search: (prev) => ({ ...prev, ...patch }) })
							}
						/>
					)
				}}
			</ResultView>
		</DashboardPage>
	)
}

/** Fast enough to see the setup script confirmed and the first read land. */
const SETTLING_REFRESH_MS = 10_000
/** Keeps the time of the last read current: Maple reads every 5 minutes. */
const STEADY_REFRESH_MS = 60_000
/** Re-reads while nothing has arrived, so the page fills in without a reload. */
const WAITING_REFRESH_MS = 30_000

function GcpInfra({
	connectors,
	nowMs,
	search,
	startTime,
	endTime,
	onSearchChange,
}: {
	/** The connections that collect metrics; none when metrics are switched off on all of them. */
	connectors: ReadonlyArray<V2GcpConnector>
	nowMs: number
	search: GcpSearchParams
	startTime: string
	endTime: string
	onSearchChange: (patch: Partial<GcpSearchParams>) => void
}) {
	// Every reporting service at once: a view switch reads nothing but its sparklines.
	const fleetAtom = gcpInfraFleetResultAtom({ data: { startTime, endTime } })
	const fleetResult = useRefreshableAtomValue(fleetAtom)
	const refreshFleet = useAtomRefresh(fleetAtom)

	const fleet = Result.builder(fleetResult)
		.onSuccess((response) => response.services)
		.orElse(() => null)
	const reporting = fleet !== null && fleet.length > 0
	const notice = fleet === null ? null : gcpInfraNotice(connectors, reporting, nowMs)
	const waiting = notice?.kind === "waiting"
	// The first read flips the status before its metrics are queryable, so a quiet page keeps
	// looking. A fixed range is left alone: it cannot gain new metrics.
	const quiet = notice?.kind === "quiet" && search.startTime === undefined
	useIntervalRefresh(refreshFleet, { intervalMs: WAITING_REFRESH_MS, enabled: waiting || quiet })

	const collecting = connectors.length > 0
	const requested = gcpRequestedView(search.view, search.tab)
	// The page resolves the same view; its sparklines are read here, for that view only.
	const { view } = useMemo(
		() =>
			gcpListScope(
				fleet === null ? null : gcpListRows(fleet, NO_GCP_SPARKS),
				{ view: requested, project: search.project, region: search.region },
				collecting,
			),
		[fleet, requested, search.project, search.region, collecting],
	)
	const timeSearch = pickTimeRangeSearch(search)

	// Metrics switched off, and nothing collected before in this range.
	if (connectors.length === 0 && fleet !== null && !reporting) {
		return (
			<>
				<GcpHero />
				<IntegrationNotConnected
					icon={<GoogleCloudIcon size={16} />}
					title="Turn on metrics for Google Cloud"
					description="Your Google Cloud connections forward logs only. Turn on Metrics and resources under Configure in the Google Cloud integration, then run the setup script."
					integration="gcp"
					actionLabel="Open the integration"
					docsPage="gcp"
				/>
			</>
		)
	}
	if (Result.isFailure(fleetResult)) {
		return (
			<>
				<GcpHero />
				<ResultView
					result={fleetResult}
					loading={null}
					errorTitle="Failed to load Google Cloud workloads"
					onRetry={refreshFleet}
				>
					{() => null}
				</ResultView>
			</>
		)
	}
	const page = {
		fleet,
		projectHealth: gcpProjectHealth(connectors, nowMs),
		collecting,
		notice: notice === null ? null : <GcpNotice notice={notice} />,
		resources: (
			<GcpResources
				filter={{ type: search.type || undefined, project: search.project || undefined }}
				onFilterChange={onSearchChange}
				timeSearch={timeSearch}
				syncError={gcpResourcesError(connectors)}
			/>
		),
		state: {
			view: requested,
			q: search.q,
			scope: search.scope,
			project: search.project,
			region: search.region,
		},
		// A view of its own replaces a link's old `?tab=`.
		onStateChange: (patch: Partial<GcpListState>) =>
			onSearchChange(patch.view === undefined ? patch : { ...patch, tab: undefined }),
		timeSearch,
		waiting: fleetResult.waiting,
	}
	const services = gcpSparklineServices(view)
	return services.length === 0 ? (
		<GcpListPage {...page} sparks={NO_GCP_SPARKS} />
	) : (
		<GcpListWithSparks
			{...page}
			services={services}
			cloudSql={view === "cloudSql"}
			startTime={startTime}
			endTime={endTime}
		/>
	)
}

/** The list with the sparklines of its view's services, drawn once they arrive. */
function GcpListWithSparks({
	services,
	cloudSql,
	startTime,
	endTime,
	...page
}: Omit<ComponentProps<typeof GcpListPage>, "sparks"> & {
	services: ReadonlyArray<GcpInfraServiceId>
	/** The Cloud SQL view: its rows join the inventory's instances. */
	cloudSql: boolean
	startTime: string
	endTime: string
}) {
	const bucketSeconds = gcpSparklineBucketSeconds(startTime, endTime)
	const sparksResult = useRefreshableAtomValue(
		gcpInfraSparklinesResultAtom({ data: { startTime, endTime, bucketSeconds, services } }),
	)
	const sparks = useMemo(
		() =>
			Result.builder(sparksResult)
				.onSuccess((response) => gcpSparks(response.services, { startTime, endTime, bucketSeconds }))
				.orElse(() => NO_GCP_SPARKS),
		[sparksResult, startTime, endTime, bucketSeconds],
	)
	return cloudSql ? (
		<GcpListWithInstances {...page} sparks={sparks} />
	) : (
		<GcpListPage {...page} sparks={sparks} />
	)
}

/**
 * The Cloud SQL list with each instance's settings from the inventory: engine, size,
 * `max_connections`, its primary. The rows show from the metrics alone until it answers, or when
 * it fails.
 */
function GcpListWithInstances(page: ComponentProps<typeof GcpListPage>) {
	const result = useAtomValue(
		retainedInternalQuery("integrations", "gcpResources", {
			query: GCP_CLOUD_SQL_INVENTORY_QUERY,
			reactivityKeys: ["gcpIntegration"],
		}),
	)
	const instances = useMemo(
		() =>
			Result.builder(result)
				.onSuccess((inventory) => gcpCloudSqlInstances(inventory.resources))
				.orElse(() => undefined),
		[result],
	)
	return <GcpListPage {...page} cloudSqlInstances={instances} />
}

function GcpHero() {
	return (
		<PageHero
			title="Google Cloud"
			description="Workloads and resources of your connected Google Cloud projects, from Cloud Monitoring metrics and Cloud Asset Inventory."
		/>
	)
}

function GcpNotice({ notice }: { notice: GcpInfraNotice }) {
	const integration = (label: string) => (
		<AlertAction>
			<Button
				size="sm"
				variant="outline"
				render={<Link to="/integrations" search={{ integration: "gcp" }} />}
			>
				{label}
			</Button>
		</AlertAction>
	)
	switch (notice.kind) {
		case "failing":
			return (
				<Alert variant="warn">
					<CircleWarningIcon size={16} />
					<AlertTitle>Maple can&apos;t read Google Cloud metrics</AlertTitle>
					<AlertDescription>
						<GcpMessage text={notice.error} />
					</AlertDescription>
					{integration("Check the connection")}
				</Alert>
			)
		case "incomplete":
			return (
				<Alert variant="warn">
					<CircleWarningIcon size={16} />
					<AlertTitle>Some Google Cloud metrics are missing</AlertTitle>
					<AlertDescription>
						<GcpMessage text={notice.error} />
					</AlertDescription>
				</Alert>
			)
		case "stalled":
			return (
				<Alert variant="warn">
					<CircleWarningIcon size={16} />
					<AlertTitle>Google Cloud metrics have stalled</AlertTitle>
					<AlertDescription>
						Maple has not read Cloud Monitoring for over 30 minutes. It retries on its own.
					</AlertDescription>
				</Alert>
			)
		case "waiting":
			return (
				<Alert variant="info" role="status">
					<Spinner size={16} />
					<AlertTitle>Collecting your first Google Cloud metrics</AlertTitle>
					<AlertDescription>
						Maple reads Cloud Monitoring every 5 minutes, about 5 minutes behind, so the first
						numbers land within about 10 minutes of the setup script. This page updates on its
						own.
					</AlertDescription>
				</Alert>
			)
		case "off":
			return (
				<Alert role="status">
					<CircleInfoIcon size={16} />
					<AlertTitle>Google Cloud metrics are off</AlertTitle>
					<AlertDescription>
						These tables show what Maple collected before they were turned off. To collect again,
						turn on Metrics and resources under Configure in the Google Cloud integration, then
						run the setup script.
					</AlertDescription>
					{integration("Open the integration")}
				</Alert>
			)
		case "quiet":
			return (
				<Alert variant="info" role="status">
					<CircleInfoIcon size={16} />
					<AlertTitle>No Google Cloud metrics in this time range</AlertTitle>
					<AlertDescription>
						Widen the time range, or reload to include the latest read.
					</AlertDescription>
				</Alert>
			)
	}
}
