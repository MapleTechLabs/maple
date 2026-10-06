import { useState } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { ResourceAttributesCard } from "@/components/infra/primitives/resource-attributes-card"
import { NoMetricsMessage } from "@/components/infra/primitives/no-metrics-message"
import { formatPercent } from "@maple/ui/lib/format"

import type { PodInfraMetric } from "@/api/warehouse/infra"
import { ErrorState } from "@/components/common/error-state"
import { FolderIcon } from "@/components/icons"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { PodDetailChart } from "@/components/infra/k8s-detail-chart"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { severityLevel } from "@/components/infra/format"
import { PageHero, HeroChip } from "@/components/common/page-hero"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { podDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const DEFAULT_PRESET = "1h"

const podDetailSearchSchema = Schema.Struct({
	namespace: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/kubernetes/pods/$podName")({
	component: PodDetailPage,
	validateSearch: Schema.toStandardSchemaV1(podDetailSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const METRIC_OPTIONS = [
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "cpu_limit", label: "CPU / limit" },
	{ value: "cpu_request", label: "CPU / request" },
	{ value: "memory_limit", label: "Mem / limit" },
	{ value: "memory_request", label: "Mem / request" },
] as const satisfies ReadonlyArray<{ value: PodInfraMetric; label: string }>

function PodDetailPage() {
	const { podName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const namespace = search.namespace
	const [metric, setMetric] = useState<PodInfraMetric>("cpu_usage")

	// The window lives in the URL, so arriving from a list keeps the list's
	// window rather than snapping back to the last hour.
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const bucketSeconds = bucketSecondsForRange(startTime, endTime)

	const summaryAtom = podDetailSummaryResultAtom({
		data: { podName, namespace, startTime, endTime },
	})
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const rightPanel = summary ? (
		<ResourceAttributesCard icon={FolderIcon}>
			<DetailRail.MetaRow label="k8s.pod.name" value={summary.podName} />
			<DetailRail.MetaRow label="k8s.namespace.name" value={summary.namespace} />
			<DetailRail.MetaRow label="k8s.node.name" value={summary.nodeName} />
			<DetailRail.MetaRow label="k8s.pod.uid" value={summary.podUid} />
			<DetailRail.MetaRow label="k8s.pod.qos_class" value={summary.qosClass} />
			<DetailRail.MetaRow label="k8s.deployment.name" value={summary.deploymentName} />
			<DetailRail.MetaRow label="k8s.statefulset.name" value={summary.statefulsetName} />
			<DetailRail.MetaRow label="k8s.daemonset.name" value={summary.daemonsetName} />
			<DetailRail.MetaRow label="k8s.pod.start_time" value={summary.podStartTime} />
		</ResourceAttributesCard>
	) : null

	return (
		<KubernetesShell
			view="pods"
			trail={[{ label: podName }]}
			timeSearch={search}
			startTime={startTime}
			endTime={endTime}
			defaultPreset={DEFAULT_PRESET}
			onTimeChange={(range, options) =>
				void navigate({
					replace: options?.replace,
					search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
				})
			}
			rightPanel={rightPanel}
		>
			<div className="space-y-6">
				<PageHero
					title={<span className="font-mono">{podName}</span>}
					description="Pod metrics from the kubelet stats receiver."
					meta={
						<>
							{namespace && <HeroChip>ns {namespace}</HeroChip>}
							{summary?.nodeName && <HeroChip>node {summary.nodeName}</HeroChip>}
							{summary?.qosClass && <HeroChip>qos {summary.qosClass}</HeroChip>}
						</>
					}
				/>

				{Result.isInitial(summaryResult) ? (
					<StatRailLoading />
				) : Result.isFailure(summaryResult) ? (
					<ErrorState
						error={summaryResult.cause}
						title="Failed to load pod metrics"
						onRetry={refreshSummary}
					/>
				) : summary ? (
					<StatRail>
						<StatRailItem
							eyebrow="CPU vs limit"
							value={formatPercent(summary.cpuLimitPct)}
							tone={severityLevel(summary.cpuLimitPct)}
							compact
						/>
						<StatRailItem
							eyebrow="CPU vs request"
							value={formatPercent(summary.cpuRequestPct)}
							compact
						/>
						<StatRailItem
							eyebrow="Memory vs limit"
							value={formatPercent(summary.memoryLimitPct)}
							tone={severityLevel(summary.memoryLimitPct)}
							compact
						/>
						<StatRailItem
							eyebrow="Memory vs request"
							value={formatPercent(summary.memoryRequestPct)}
							compact
						/>
					</StatRail>
				) : (
					<NoMetricsMessage noun="pod" />
				)}

				<div className="space-y-3">
					<SegmentPivot
						ariaLabel="Metric"
						options={METRIC_OPTIONS}
						value={metric}
						onChange={setMetric}
					/>
					<PodDetailChart
						podName={podName}
						namespace={namespace}
						metric={metric}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
					/>
				</div>
			</div>
		</KubernetesShell>
	)
}
