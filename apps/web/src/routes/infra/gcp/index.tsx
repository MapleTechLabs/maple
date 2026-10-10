import { useMemo } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { GCP_INFRA_SERVICES } from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"

import { PageHero } from "@/components/common/page-hero"
import { ResultView } from "@/components/common/result-view"
import {
	UnderlineTabCount,
	UnderlineTabStrip,
	underlineTabClass,
} from "@/components/common/underline-link-tabs"
import { CircleInfoIcon, CircleWarningIcon, GoogleCloudIcon } from "@/components/icons"
import { GcpResources } from "@/components/infra/gcp/gcp-resources"
import {
	GcpServiceTable,
	GcpServiceTableLoading,
	GcpSummaryBand,
	GcpSummaryBandLoading,
} from "@/components/infra/gcp/gcp-service-table"
import {
	GCP_INFRA_TABS,
	GCP_RESOURCES_TAB,
	NO_GCP_FLEET,
	gcpFleet,
	gcpInScope,
	gcpInfraNotice,
	gcpInfraSetupPending,
	gcpInfraTabs,
	gcpResourcesError,
	gcpWorkloadProject,
	gcpWorkloadRegion,
	type GcpInfraNotice,
	type GcpInfraTab,
} from "@/components/infra/gcp/tabs"
import { FLEET_BAND_BOXED } from "@/components/infra/primitives/fleet-band"
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
import { gcpInfraFleetResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

const gcpSearchSchema = Schema.Struct({
	// A plain string: a stale or mistyped link falls back to the first tab instead of the error page.
	tab: Schema.optional(Schema.String),
	/** Every tab: the project. Service tabs: the region, a name search and a health scope. */
	project: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	// Spelled out, as on the sibling pages: importing the list would put the tab model in the startup bundle.
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "erroring"])),
	/** Resources tab: the asset type. */
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
	useIntervalRefresh(refreshStatus, { intervalMs: SETTLING_REFRESH_MS, enabled: settling })

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
			<PageHero
				title="Google Cloud"
				description="Workloads and resources of your connected Google Cloud projects, from Cloud Monitoring metrics and Cloud Asset Inventory."
			/>
			<ResultView
				result={statusResult}
				loading={<Skeleton className="h-64 w-full" />}
				errorTitle="Failed to load the Google Cloud integration"
				onRetry={refreshStatus}
			>
				{(status) => {
					if (status.connectors.length === 0) {
						return (
							<IntegrationNotConnected
								icon={<GoogleCloudIcon size={16} />}
								title="Connect Google Cloud to see your infrastructure"
								description="Connect an organization, folder or project that collects metrics and resources. Maple reads Cloud Monitoring metrics and lists your resources, with no agents to install."
								integration="gcp"
								actionLabel="Connect Google Cloud"
								docsPage="gcp"
							/>
						)
					}
					// None when metrics are switched off everywhere: what was collected before still shows.
					const connectors = status.connectors.filter((connector) => connector.metrics_enabled)
					if (connectors.length > 0 && gcpInfraSetupPending(connectors, nowMs)) {
						return (
							<IntegrationNotConnected
								icon={<GoogleCloudIcon size={16} />}
								title="Finish setting up Google Cloud"
								description="Metrics and resources are on, but the setup script hasn't run yet."
								integration="gcp"
								actionLabel="Open the integration"
								docsPage="gcp"
							/>
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
	// Every reporting service at once: the band counts them all, and a tab switch reads nothing.
	const fleetAtom = gcpInfraFleetResultAtom({ data: { startTime, endTime } })
	const fleetResult = useRefreshableAtomValue(fleetAtom)
	const refreshFleet = useAtomRefresh(fleetAtom)

	const fleet = useMemo(
		() =>
			Result.builder(fleetResult)
				.onSuccess((response) => gcpFleet(response.services))
				.orElse(() => NO_GCP_FLEET),
		[fleetResult],
	)
	const reporting = fleet.map((entry) => entry.service)
	const notice = Result.isSuccess(fleetResult)
		? gcpInfraNotice(connectors, reporting.length > 0, nowMs)
		: null
	const waiting = notice?.kind === "waiting"
	// The first read flips the status before its metrics are queryable, so a quiet page keeps
	// looking. A fixed range is left alone: it cannot gain new metrics.
	const quiet = notice?.kind === "quiet" && search.startTime === undefined
	useIntervalRefresh(refreshFleet, { intervalMs: WAITING_REFRESH_MS, enabled: waiting || quiet })

	const requested: GcpInfraTab | undefined = GCP_INFRA_TABS.find((candidate) => candidate === search.tab)
	const tabs = gcpInfraTabs(reporting, requested, connectors.length > 0)
	const tab = tabs.find((candidate) => candidate === requested) ?? tabs[0]

	// An empty param in a hand-edited address is no filter.
	const place = { project: search.project || undefined, region: search.region || undefined }
	const assetType = search.type || undefined
	// The project and region filters cover every service tab, and so does the band above them.
	const places = fleet.flatMap(({ service, workloads }) =>
		workloads.map((workload) => ({
			project: gcpWorkloadProject(service, workload.keys),
			region: gcpWorkloadRegion(service, workload.keys),
		})),
	)
	const options = (values: ReadonlyArray<string | undefined>) =>
		[...new Set(values.flatMap((value) => (value ? [value] : [])))].sort()
	const inPlace = fleet.map((entry) => ({
		...entry,
		workloads: entry.workloads.filter(
			(workload) =>
				(place.project === undefined ||
					gcpWorkloadProject(entry.service, workload.keys) === place.project) &&
				(place.region === undefined ||
					gcpWorkloadRegion(entry.service, workload.keys) === place.region),
		),
	}))
	const timeSearch = pickTimeRangeSearch(search)
	const activeScope = search.scope

	// Metrics switched off, and nothing collected before in this range.
	if (connectors.length === 0 && Result.isSuccess(fleetResult) && reporting.length === 0) {
		return (
			<IntegrationNotConnected
				icon={<GoogleCloudIcon size={16} />}
				title="Turn on metrics for Google Cloud"
				description="Your Google Cloud connections forward logs only. Turn on Metrics and resources under Configure in the Google Cloud integration, then run the setup script."
				integration="gcp"
				actionLabel="Open the integration"
				docsPage="gcp"
			/>
		)
	}
	return (
		<ResultView
			result={fleetResult}
			errorTitle="Failed to load Google Cloud workloads"
			onRetry={refreshFleet}
			loading={
				<div className="space-y-6">
					<GcpSummaryBandLoading className={FLEET_BAND_BOXED} />
					<GcpServiceTableLoading
						service={
							requested === undefined || requested === GCP_RESOURCES_TAB
								? "cloudRun"
								: requested
						}
					/>
				</div>
			}
		>
			{(_, { waiting: refreshing }) => (
				<div className="space-y-6">
					{notice === null ? null : <GcpNotice notice={notice} />}
					{reporting.length === 0 ? null : (
						<GcpSummaryBand
							workloads={inPlace.flatMap((entry) => entry.workloads)}
							activeScope={search.scope}
							onScopeChange={(scope) => onSearchChange({ scope })}
							waiting={refreshing}
							className={FLEET_BAND_BOXED}
						/>
					)}
					{/* Below the band, which counts every tab. The strip scrolls sideways on a phone. */}
					<UnderlineTabStrip navigation label="Google Cloud services" bleed={false}>
						{tabs.map((candidate) => (
							<Link
								key={candidate}
								to="/infra/gcp"
								// The place and scope carry over; a name search and the asset type do not.
								search={{ ...timeSearch, ...place, scope: activeScope, tab: candidate }}
								aria-current={candidate === tab ? "page" : undefined}
								className={underlineTabClass(candidate === tab)}
							>
								{candidate === GCP_RESOURCES_TAB
									? "Resources"
									: GCP_INFRA_SERVICES[candidate].title}
								{/* With a band cell active: how many of its workloads each tab holds. */}
								<UnderlineTabCount
									count={
										activeScope === undefined || candidate === GCP_RESOURCES_TAB
											? undefined
											: (
													inPlace.find((entry) => entry.service === candidate)
														?.workloads ?? []
												).filter((workload) => gcpInScope(workload, activeScope))
													.length
									}
								/>
							</Link>
						))}
					</UnderlineTabStrip>
					{tab === GCP_RESOURCES_TAB ? (
						<GcpResources
							filter={{ type: assetType, project: place.project }}
							onFilterChange={onSearchChange}
							timeSearch={timeSearch}
							syncError={gcpResourcesError(connectors)}
						/>
					) : (
						<GcpServiceTable
							// A tab keeps its own sort.
							key={tab}
							service={tab}
							workloads={inPlace.find((entry) => entry.service === tab)?.workloads ?? []}
							truncated={fleet.some((entry) => entry.service === tab && entry.truncated)}
							failed={fleet.some((entry) => entry.service === tab && entry.failed)}
							query={search.q ?? ""}
							scope={search.scope}
							place={place}
							projects={options(places.map((place) => place.project))}
							regions={options(places.map((place) => place.region))}
							onQueryChange={(q) => onSearchChange({ q: q || undefined })}
							onPlaceChange={onSearchChange}
							timeSearch={timeSearch}
							waiting={refreshing}
						/>
					)}
				</div>
			)}
		</ResultView>
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
