import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { useState } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { ErrorState } from "@/components/common/error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DockerIcon } from "@/components/icons"
import { ContainerDetailChart } from "@/components/infra/container-detail-chart"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { containerDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TIME_PRESETS, bucketSecondsFor } from "@/components/infra/constants"
import { formatSeconds } from "@/components/infra/chart-utils"
import { severityLevel } from "@/components/infra/format"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { ContainerInfraMetric } from "@/api/warehouse/infra"

const containerDetailSearchSchema = Schema.Struct({
	// Docker container names are unique per host only — the list link carries the
	// host so a fleet-wide name like `redis` resolves to one container.
	host: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/infra/containers/$containerName")({
	component: ContainerDetailPage,
	validateSearch: Schema.toStandardSchemaV1(containerDetailSearchSchema),
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
	const [preset, setPreset] = useState("1h")
	const [metric, setMetric] = useState<ContainerInfraMetric>("cpu")

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
	const bucketSeconds = bucketSecondsFor(preset)

	const summaryAtom = containerDetailSummaryResultAtom({
		data: { containerName, hostName, startTime, endTime },
	})
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const toolbar = (
		<Select value={preset} onValueChange={(v) => v && setPreset(v)}>
			<SelectTrigger className="w-[180px]">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{TIME_PRESETS.map((p) => (
					<SelectItem key={p.value} value={p.value}>
						{p.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)

	const rightSidebar = summary ? (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium">
					<DockerIcon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1">
				<DetailRail.MetaRow label="container.name" value={summary.containerName} />
				<DetailRail.MetaRow label="container.id" value={summary.containerId} />
				<DetailRail.MetaRow label="container.image.name" value={summary.imageName} />
				<DetailRail.MetaRow label="container.runtime" value={summary.runtime} />
				<DetailRail.MetaRow label="host.name" value={summary.hostName} />
				<DetailRail.MetaRow label="compose.project" value={summary.composeProject} />
				<DetailRail.MetaRow label="compose.service" value={summary.composeService} />
			</CardContent>
		</Card>
	) : null

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Infrastructure", href: "/infra" },
					{ label: "Containers", href: "/infra/containers" },
					{ label: containerName },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header>{toolbar}</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="space-y-6">
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
								<Skeleton className="h-24 w-full rounded-md" />
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
									<StatRailItem
										eyebrow="Memory"
										value={formatBytes(summary.memoryBytesAvg)}
										compact
									/>
									<StatRailItem
										eyebrow="Restarts"
										value={summary.restartsDelta.toLocaleString()}
										tone={summary.restartsDelta > 0 ? "warn" : undefined}
										compact
									/>
									<StatRailItem
										eyebrow="Uptime"
										value={formatSeconds(summary.uptimeSeconds)}
										compact
									/>
								</StatRail>
							) : (
								<EmptyMessage dashed className="flex flex-col items-center gap-3 py-12">
									<p>
										This container sent no metrics in the selected window. It may have
										stopped earlier: try a wider range, or go back to the containers list.
									</p>
									<div className="flex flex-wrap items-center justify-center gap-2">
										{preset === "7d" ? null : (
											<Button
												variant="outline"
												size="sm"
												onClick={() => setPreset("7d")}
											>
												Show last 7 days
											</Button>
										)}
										<Button
											variant="outline"
											size="sm"
											render={<Link to="/infra/containers" />}
										>
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
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
				<DashboardLayout.RightPanel>{rightSidebar}</DashboardLayout.RightPanel>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
