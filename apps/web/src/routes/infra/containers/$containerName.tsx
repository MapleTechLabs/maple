import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { useState } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { Button } from "@maple/ui/components/ui/button"
import {
	ResourceAttributesCard,
	ResourceAttributesCardSkeleton,
} from "@/components/infra/primitives/resource-attributes-card"

import { ErrorState } from "@/components/common/error-state"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { DockerIcon } from "@/components/icons"
import { ContainerDetailChart } from "@/components/infra/container-detail-chart"
import { PageHero, HeroChip } from "@/components/common/page-hero"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"
import { containerDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { formatSeconds } from "@/components/infra/chart-utils"
import { severityLevel } from "@/components/infra/format"
import { formatBytes, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { ContainerInfraMetric } from "@/api/warehouse/infra"
import type { TimeRange } from "@/components/time-range-picker/types"
import {
	TimeRangeSearchFields,
	WIDEN_TIME_PRESET,
	applyTimeRangeSearch,
	canWidenTimeRange,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"

const DEFAULT_PRESET = "1h"

const containerDetailSearchSchema = Schema.Struct({
	// Docker container names are unique per host only — the list link carries the
	// host so a fleet-wide name like `redis` resolves to one container.
	host: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/containers/$containerName")({
	component: ContainerDetailPage,
	validateSearch: Schema.toStandardSchemaV1(containerDetailSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const METRIC_TABS = [
	{ value: "cpu", label: "CPU %" },
	{ value: "memory_percent", label: "Mem / limit" },
	{ value: "memory_bytes", label: "Memory" },
	{ value: "network", label: "Network I/O" },
	{ value: "disk_io", label: "Block I/O" },
] as const

function ContainerDetailPage() {
	const { containerName } = Route.useParams()
	const search = Route.useSearch()
	const hostName = search.host
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? DEFAULT_PRESET
	const [metric, setMetric] = useState<ContainerInfraMetric>("cpu")

	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	const bucketSeconds = bucketSecondsForRange(startTime, endTime)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	const summaryAtom = containerDetailSummaryResultAtom({
		data: { containerName, hostName, startTime, endTime },
	})
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const rightSidebar = summary ? (
		<ResourceAttributesCard icon={DockerIcon}>
			<DetailRail.MetaRow label="container.name" value={summary.containerName} />
			<DetailRail.MetaRow label="container.id" value={summary.containerId} />
			<DetailRail.MetaRow label="container.image.name" value={summary.imageName} />
			<DetailRail.MetaRow label="container.runtime" value={summary.runtime} />
			<DetailRail.MetaRow label="host.name" value={summary.hostName} />
			<DetailRail.MetaRow label="compose.project" value={summary.composeProject} />
			<DetailRail.MetaRow label="compose.service" value={summary.composeService} />
		</ResourceAttributesCard>
	) : Result.isInitial(summaryResult) ? (
		<ResourceAttributesCardSkeleton icon={DockerIcon} />
	) : null

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				{ label: "Containers", href: "/infra/containers" },
				{ label: containerName },
			]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			rightPanel={rightSidebar}
			gap="lg"
		>
			<PageHero
				title={<span className="font-mono">{containerName}</span>}
				description="Container metrics from the Docker stats receiver."
				meta={
					<>
						{summary?.hostName && <HeroChip>host {summary.hostName}</HeroChip>}
						{summary?.imageName && <HeroChip>image {summary.imageName}</HeroChip>}
						{summary?.runtime && <HeroChip>runtime {summary.runtime}</HeroChip>}
					</>
				}
			/>

			{Result.isInitial(summaryResult) ? (
				<StatRailLoading count={5} />
			) : Result.isFailure(summaryResult) ? (
				<ErrorState
					error={summaryResult.cause}
					title="Failed to load container metrics"
					onRetry={refreshSummary}
				/>
			) : summary ? (
				<StatRail>
					<StatRailItem
						eyebrow="CPU"
						value={formatPercent(summary.cpuPct)}
						tone={severityLevel(summary.cpuPct)}
						compact
					/>
					<StatRailItem
						eyebrow="Memory vs limit"
						value={formatPercent(summary.memoryPct)}
						tone={severityLevel(summary.memoryPct)}
						compact
					/>
					<StatRailItem eyebrow="Memory" value={formatBytes(summary.memoryBytesAvg)} compact />
					<StatRailItem
						eyebrow="Restarts"
						value={formatNumber(summary.restartsDelta)}
						tone={summary.restartsDelta > 0 ? "warn" : undefined}
						compact
					/>
					<StatRailItem eyebrow="Uptime" value={formatSeconds(summary.uptimeSeconds)} compact />
				</StatRail>
			) : (
				<EmptyMessage dashed className="flex flex-col items-center gap-3 py-12">
					<p>
						This container sent no metrics in the selected window. It may have stopped earlier:
						try a wider range, or go back to the containers list.
					</p>
					<div className="flex flex-wrap items-center justify-center gap-2">
						{canWidenTimeRange(search, DEFAULT_PRESET) ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() => handleTimeChange({ presetValue: WIDEN_TIME_PRESET })}
							>
								Show last 7 days
							</Button>
						) : null}
						<Button variant="outline" size="sm" render={<Link to="/infra/containers" />}>
							Back to containers
						</Button>
					</div>
				</EmptyMessage>
			)}

			<div className="space-y-3">
				<SegmentPivot<ContainerInfraMetric>
					ariaLabel="Metric"
					options={METRIC_TABS}
					value={metric}
					onChange={setMetric}
				/>
				<ContainerDetailChart
					containerName={containerName}
					hostName={hostName}
					metric={metric}
					startTime={startTime}
					endTime={endTime}
					bucketSeconds={bucketSeconds}
				/>
			</div>
		</DashboardPage>
	)
}
