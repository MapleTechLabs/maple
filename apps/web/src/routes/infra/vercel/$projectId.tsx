import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import type {
	VercelAiGatewayBucket,
	VercelAiGatewayResponse,
	VercelDeploymentSummary,
	VercelInfraProject,
	VercelInfraProjectDetailResponse,
	VercelInfraRequestBucket,
	VercelProjectStatus,
} from "@maple/domain/http"

import { ErrorState } from "@/components/common/error-state"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	fillBuckets,
	vercelProjectRow,
	zeroAiGatewayBucket,
	zeroRequestBucket,
} from "@/components/infra/vercel/list-model"
import { VercelProjectPage } from "@/components/infra/vercel/vercel-project-page"
import { VERCEL_STATUS_REACTIVITY_KEY, vercelStatusAtom } from "@/components/integrations/vercel-status"
import { DashboardPage } from "@/components/layout/dashboard-page"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import type { TimeRange } from "@/components/time-range-picker/types"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import {
	vercelAiGatewayResultAtom,
	vercelProjectDetailResultAtom,
	vercelProjectsResultAtom,
	vercelRequestTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"

const vercelProjectSearchSchema = Schema.Struct({ ...TimeRangeSearchFields })

export const Route = createFileRoute("/infra/vercel/$projectId")({
	component: VercelProjectRoute,
	validateSearch: Schema.toStandardSchemaV1(vercelProjectSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const DEFAULT_PRESET = "24h"
const DEPLOYMENTS_LIMIT = 20

function VercelProjectRoute() {
	const { projectId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const range = { startTime, endTime, bucketSeconds, projectId }

	const handleTimeChange = (next: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, next) }),
		})
	}

	const statusResult = useAtomValue(vercelStatusAtom)
	const statusProjects = Result.builder(statusResult)
		.onSuccess((status): ReadonlyArray<VercelProjectStatus> | null => status.projects)
		.orElse((): ReadonlyArray<VercelProjectStatus> | null => null)
	// The list's own read: picking this project's row shares its cached atom.
	const projectsAtom = vercelProjectsResultAtom({ data: { startTime, endTime } })
	const projectsResult = useRefreshableAtomValue(projectsAtom)
	const refreshProjects = useAtomRefresh(projectsAtom)
	const projects = Result.builder(projectsResult)
		.onSuccess((response): ReadonlyArray<VercelInfraProject> | null => response.projects)
		.orElse((): ReadonlyArray<VercelInfraProject> | null => null)

	const timeseriesAtom = vercelRequestTimeseriesResultAtom({ data: range })
	const timeseriesResult = useRefreshableAtomValue(timeseriesAtom)
	const refreshTimeseries = useAtomRefresh(timeseriesAtom)
	const rawBuckets = Result.builder(timeseriesResult)
		.onSuccess((response): ReadonlyArray<VercelInfraRequestBucket> | null => response.buckets)
		.orElse((): ReadonlyArray<VercelInfraRequestBucket> | null => null)

	const detailAtom = vercelProjectDetailResultAtom({ data: { startTime, endTime, projectId } })
	const detailResult = useRefreshableAtomValue(detailAtom)
	const refreshDetail = useAtomRefresh(detailAtom)
	const detail = Result.builder(detailResult)
		.onSuccess((response): VercelInfraProjectDetailResponse | null => response)
		.orElse((): VercelInfraProjectDetailResponse | null => null)

	const deploymentsAtom = retainedInternalQuery("integrations", "vercelDeployments", {
		query: { projectId, limit: DEPLOYMENTS_LIMIT },
		reactivityKeys: [VERCEL_STATUS_REACTIVITY_KEY],
	})
	const deploymentsResult = useRefreshableAtomValue(deploymentsAtom)
	const refreshDeployments = useAtomRefresh(deploymentsAtom)
	const deployments = Result.builder(deploymentsResult)
		.onSuccess((response): ReadonlyArray<VercelDeploymentSummary> | null => response.deployments)
		.orElse((): ReadonlyArray<VercelDeploymentSummary> | null => null)

	const aiAtom = vercelAiGatewayResultAtom({ data: range })
	const aiResult = useRefreshableAtomValue(aiAtom)
	const refreshAi = useAtomRefresh(aiAtom)
	const aiGateway = Result.builder(aiResult)
		.onSuccess((response): VercelAiGatewayResponse | null => response)
		.orElse((): VercelAiGatewayResponse | null => null)

	const buckets = useMemo(
		() =>
			rawBuckets === null
				? null
				: fillBuckets(rawBuckets, { startTime, endTime, bucketSeconds }, zeroRequestBucket),
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
	// A failed status read still shows the warehouse row, under the project id.
	const row = useMemo(
		() => (projects === null ? null : vercelProjectRow(projectId, statusProjects ?? [], projects)),
		[projectId, projects, statusProjects],
	)
	const project = statusProjects?.find((candidate) => candidate.id === projectId) ?? null

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				{ label: "Vercel", href: "/infra/vercel" },
				{ label: project?.name ?? row?.name ?? projectId },
			]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			gap="lg"
		>
			<VercelProjectPage
				projectId={projectId}
				project={project}
				row={row}
				buckets={buckets}
				detail={detail}
				deployments={deployments}
				deploymentsError={
					Result.isFailure(deploymentsResult) && deployments === null ? (
						<ErrorState
							error={deploymentsResult.cause}
							title="Failed to load deployments"
							onRetry={refreshDeployments}
							variant="inline"
							className="px-4"
						/>
					) : undefined
				}
				aiGateway={aiGateway}
				aiTimeseries={aiTimeseries}
				error={
					Result.isFailure(projectsResult) && projects === null ? (
						<ErrorState
							error={projectsResult.cause}
							title="Failed to load this project's requests"
							onRetry={refreshProjects}
						/>
					) : Result.isFailure(timeseriesResult) && rawBuckets === null ? (
						<ErrorState
							error={timeseriesResult.cause}
							title="Failed to load this project's requests"
							onRetry={refreshTimeseries}
						/>
					) : undefined
				}
				detailError={
					Result.isFailure(detailResult) && detail === null ? (
						<ErrorState
							error={detailResult.cause}
							title="Failed to load top paths and errors"
							onRetry={refreshDetail}
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
				timeSearch={pickTimeRangeSearch(search)}
			/>
		</DashboardPage>
	)
}

const NO_AI_BUCKETS: ReadonlyArray<VercelAiGatewayBucket> = []
