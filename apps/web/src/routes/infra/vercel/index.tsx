import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import type {
	VercelAiGatewayBucket,
	VercelAiGatewayResponse,
	VercelInfraProject,
	VercelInfraRequestBucket,
	VercelIntegrationStatus,
} from "@maple/domain/http"

import { ErrorState } from "@/components/common/error-state"
import { PageHero } from "@/components/common/page-hero"
import { ResultView } from "@/components/common/result-view"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import { fillBuckets, zeroAiGatewayBucket, zeroRequestBucket } from "@/components/infra/vercel/list-model"
import {
	VERCEL_DESCRIPTION,
	VercelListPage,
	type VercelListState,
} from "@/components/infra/vercel/vercel-list-page"
import { VercelFleetBandLoading } from "@/components/infra/vercel/vercel-project-table"
import { VercelIntegrationCard } from "@/components/integrations/vercel-integration-card"
import { vercelStatusAtom } from "@/components/integrations/vercel-status"
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
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	vercelAiGatewayResultAtom,
	vercelProjectsResultAtom,
	vercelRequestTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"

const vercelSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	view: Schema.optional(Schema.Literals(["projects", "aiGateway"])),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/vercel/")({
	component: VercelPage,
	validateSearch: Schema.toStandardSchemaV1(vercelSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

/** Matches the API's default window. */
const DEFAULT_PRESET = "24h"

function VercelPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const statusResult = useAtomValue(vercelStatusAtom)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: "Vercel" }]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			gap="lg"
		>
			<ResultView
				result={statusResult}
				loading={
					<div className="space-y-6">
						<PageHero title="Vercel" description={VERCEL_DESCRIPTION} />
						<VercelFleetBandLoading />
					</div>
				}
			>
				{(status) =>
					status.connected ? (
						<VercelConnected
							status={status}
							startTime={startTime}
							endTime={endTime}
							state={{ view: search.view, q: search.q }}
							onStateChange={(patch) => navigate({ search: (prev) => ({ ...prev, ...patch }) })}
							timeSearch={pickTimeRangeSearch(search)}
						/>
					) : (
						<div className="space-y-6">
							<PageHero title="Vercel" description={VERCEL_DESCRIPTION} />
							<VercelIntegrationCard />
						</div>
					)
				}
			</ResultView>
		</DashboardPage>
	)
}

/** Re-reads while the page is empty, so the drains' first deliveries fill in without a reload. */
const EMPTY_REFRESH_MS = 15_000

function VercelConnected({
	status,
	startTime,
	endTime,
	state,
	onStateChange,
	timeSearch,
}: {
	status: VercelIntegrationStatus
	startTime: string
	endTime: string
	state: VercelListState
	onStateChange: (patch: Partial<VercelListState>) => void
	timeSearch: TimeRangeSearch
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const range = { startTime, endTime, bucketSeconds }

	const projectsAtom = vercelProjectsResultAtom({ data: { startTime, endTime } })
	const projectsResult = useRefreshableAtomValue(projectsAtom)
	const refreshProjects = useAtomRefresh(projectsAtom)
	const timeseriesAtom = vercelRequestTimeseriesResultAtom({ data: range })
	const timeseriesResult = useRefreshableAtomValue(timeseriesAtom)
	const refreshTimeseries = useAtomRefresh(timeseriesAtom)
	const aiAtom = vercelAiGatewayResultAtom({ data: range })
	const aiResult = useRefreshableAtomValue(aiAtom)
	const refreshAi = useAtomRefresh(aiAtom)

	const projects = Result.builder(projectsResult)
		.onSuccess((response): ReadonlyArray<VercelInfraProject> | null => response.projects)
		.orElse((): ReadonlyArray<VercelInfraProject> | null => null)
	const aiGateway = Result.builder(aiResult)
		.onSuccess((response): VercelAiGatewayResponse | null => response)
		.orElse((): VercelAiGatewayResponse | null => null)
	const rawBuckets = Result.builder(timeseriesResult)
		.onSuccess((response) => response.buckets)
		.orElse(() => NO_BUCKETS)
	const buckets = useMemo(
		() => fillBuckets(rawBuckets, { startTime, endTime, bucketSeconds }, zeroRequestBucket),
		[rawBuckets, startTime, endTime, bucketSeconds],
	)
	const aiTimeseries = useMemo(
		() =>
			fillBuckets(
				aiGateway?.timeseries ?? NO_AI_BUCKETS,
				{ startTime, endTime, bucketSeconds },
				zeroAiGatewayBucket,
			),
		[aiGateway, startTime, endTime, bucketSeconds],
	)

	const projectsEmpty = projects !== null && projects.length === 0
	const aiEmpty = aiGateway !== null && aiGateway.summary.requests === 0
	// With neither drain on, an empty page has nothing on the way worth polling for.
	const pollEmpty = projectsEmpty && (status.logsEnabled || status.tracesEnabled)
	useIntervalRefresh(refreshProjects, { intervalMs: EMPTY_REFRESH_MS, enabled: pollEmpty })
	useIntervalRefresh(refreshTimeseries, { intervalMs: EMPTY_REFRESH_MS, enabled: pollEmpty })
	useIntervalRefresh(refreshAi, {
		intervalMs: EMPTY_REFRESH_MS,
		enabled: aiEmpty && state.view === "aiGateway",
	})

	return (
		<VercelListPage
			status={status}
			projects={projects}
			buckets={buckets}
			aiGateway={aiGateway}
			aiTimeseries={aiTimeseries}
			projectsError={
				Result.isFailure(projectsResult) && projects === null ? (
					<ErrorState
						error={projectsResult.cause}
						title="Failed to load Vercel projects"
						onRetry={refreshProjects}
					/>
				) : undefined
			}
			bucketsError={
				Result.isFailure(timeseriesResult) && rawBuckets === NO_BUCKETS ? (
					<ErrorState
						error={timeseriesResult.cause}
						title="Failed to load the request series"
						onRetry={refreshTimeseries}
						variant="row"
					/>
				) : undefined
			}
			aiGatewayError={
				Result.isFailure(aiResult) && aiGateway === null ? (
					<ErrorState
						error={aiResult.cause}
						title="Failed to load AI Gateway usage"
						onRetry={refreshAi}
					/>
				) : undefined
			}
			state={state}
			onStateChange={onStateChange}
			timeSearch={timeSearch}
			waiting={projectsResult.waiting}
		/>
	)
}

/** Stable empty fallbacks so the fills don't recompute on every render. */
const NO_BUCKETS: ReadonlyArray<VercelInfraRequestBucket> = []
const NO_AI_BUCKETS: ReadonlyArray<VercelAiGatewayBucket> = []
