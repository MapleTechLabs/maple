import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"

import { PageHero } from "@/components/common/page-hero"
import { ResultView } from "@/components/common/result-view"
import { CircleInfoIcon, CircleWarningIcon, GoogleCloudIcon } from "@/components/icons"
import { GcpResources, type GcpResourceFilter } from "@/components/infra/gcp/gcp-resources"
import { GcpServiceTable, GcpServiceTableLoading } from "@/components/infra/gcp/gcp-service-table"
import {
	GCP_INFRA_TABS,
	GCP_RESOURCES_TAB,
	gcpInfraNotice,
	gcpInfraSetupPending,
	gcpInfraTabs,
	gcpResourcesError,
	type GcpInfraNotice,
	type GcpInfraTab,
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
	type TimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import type { TimeRange } from "@/components/time-range-picker/types"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useLiveClock } from "@/hooks/use-live-clock"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	gcpInfraMetricsResultAtom,
	gcpInfraPresenceResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"

const gcpSearchSchema = Schema.Struct({
	// A plain string: a stale or mistyped link falls back to the first tab instead of the error page.
	tab: Schema.optional(Schema.String),
	/** Resources tab: asset type and project filters. */
	type: Schema.optional(Schema.String),
	project: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

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
			<ResultView result={statusResult} loading={<Skeleton className="h-64 w-full" />}>
				{(status) => {
					if (status.connectors.length === 0) {
						return (
							<IntegrationNotConnected
								icon={<GoogleCloudIcon size={16} />}
								title="Connect Google Cloud to see your infrastructure"
								description="Connect an organization, folder or project with metrics and resources switched on. Maple reads Cloud Monitoring metrics and lists your resources, with no agents to install."
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
								description="Metrics and resources are switched on, but the setup script hasn't run yet."
								integration="gcp"
								actionLabel="Open setup script"
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
							onFilterChange={(filter) =>
								navigate({
									search: (prev) => ({
										...prev,
										type: filter.type,
										project: filter.project,
									}),
								})
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
	onFilterChange,
}: {
	/** The connections that collect metrics; none when metrics are switched off on all of them. */
	connectors: ReadonlyArray<V2GcpConnector>
	nowMs: number
	search: TimeRangeSearch & GcpResourceFilter & { tab?: string | undefined }
	startTime: string
	endTime: string
	onFilterChange: (filter: GcpResourceFilter) => void
}) {
	const presenceAtom = gcpInfraPresenceResultAtom({ data: { startTime, endTime } })
	const presenceResult = useRefreshableAtomValue(presenceAtom)
	const refreshPresence = useAtomRefresh(presenceAtom)

	const reporting = Result.builder(presenceResult)
		.onSuccess((presence) => presence.services)
		.orElse((): ReadonlyArray<GcpInfraServiceId> => [])
	const notice = Result.isSuccess(presenceResult)
		? gcpInfraNotice(connectors, reporting.length > 0, nowMs)
		: null
	const waiting = notice?.kind === "waiting"
	// The first read flips the status before its metrics are queryable, so a quiet page keeps
	// looking. A fixed range is left alone: it cannot gain new metrics.
	const quiet = notice?.kind === "quiet" && search.startTime === undefined
	useIntervalRefresh(refreshPresence, { intervalMs: WAITING_REFRESH_MS, enabled: waiting || quiet })

	const requested: GcpInfraTab | undefined = GCP_INFRA_TABS.find((candidate) => candidate === search.tab)
	const tabs = gcpInfraTabs(reporting, requested)
	const tab = requested ?? tabs[0]

	// Metrics switched off, and nothing collected before in this range.
	if (connectors.length === 0 && Result.isSuccess(presenceResult) && reporting.length === 0) {
		return (
			<IntegrationNotConnected
				icon={<GoogleCloudIcon size={16} />}
				title="Turn on metrics for Google Cloud"
				description="Your Google Cloud connections forward logs only. Switch on Metrics and resources in the Google Cloud integration, then run the setup script again."
				integration="gcp"
				actionLabel="Open the integration"
				docsPage="gcp"
			/>
		)
	}
	return (
		<ResultView result={presenceResult} loading={<Skeleton className="h-64 w-full" />}>
			{() => (
				<div className="space-y-6">
					{notice === null ? null : <GcpNotice notice={notice} />}
					{/* The strip scrolls sideways on a phone; the bottom pixel is the active underline. */}
					<Tabs value={tab} className="-mx-2 overflow-x-auto pb-px">
						<TabsList variant="underline" className="gap-x-1 py-0">
							{tabs.map((candidate) => (
								<TabsTrigger
									key={candidate}
									value={candidate}
									className="h-8 px-2 text-sm sm:h-8"
									// A tab that is a link: Base UI needs to know it is not a <button>.
									nativeButton={false}
									render={
										<Link
											to="/infra/gcp"
											search={{ ...pickTimeRangeSearch(search), tab: candidate }}
										/>
									}
								>
									{candidate === GCP_RESOURCES_TAB
										? "Resources"
										: GCP_INFRA_SERVICES[candidate].title}
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
					{tab === GCP_RESOURCES_TAB ? (
						<GcpResources
							filter={{ type: search.type, project: search.project }}
							onFilterChange={onFilterChange}
							syncError={gcpResourcesError(connectors)}
						/>
					) : (
						<GcpServiceTab key={tab} service={tab} startTime={startTime} endTime={endTime} />
					)}
				</div>
			)}
		</ResultView>
	)
}

function GcpServiceTab({
	service,
	startTime,
	endTime,
}: {
	service: GcpInfraServiceId
	startTime: string
	endTime: string
}) {
	const result = useRefreshableAtomValue(
		gcpInfraMetricsResultAtom({ data: { startTime, endTime, service } }),
	)
	return (
		<ResultView result={result} loading={<GcpServiceTableLoading service={service} />}>
			{(response, { waiting }) => (
				<GcpServiceTable service={service} points={response.points} waiting={waiting} />
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
				<Alert variant="info" role="status">
					<CircleInfoIcon size={16} />
					<AlertTitle>Google Cloud metrics are switched off</AlertTitle>
					<AlertDescription>
						These tables show what Maple collected before. To collect again, switch on Metrics and
						resources in the Google Cloud integration, then run the setup script again.
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
