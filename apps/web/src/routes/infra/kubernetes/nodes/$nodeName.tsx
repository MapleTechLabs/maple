import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { SectionHeading } from "@/components/common/section-heading"
import { useState } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { ResourceAttributesCard } from "@/components/infra/primitives/resource-attributes-card"
import { NoMetricsMessage } from "@/components/infra/primitives/no-metrics-message"
import { formatUptime } from "@maple/ui/lib/format"

import type { NodeInfraMetric } from "@/api/warehouse/infra"
import { ServerIcon } from "@/components/icons"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { NodeDetailChart } from "@/components/infra/k8s-detail-chart"
import { PodTable } from "@/components/infra/pod-table"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { PageHero, HeroChip } from "@/components/common/page-hero"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { listPodsResultAtom, nodeDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const DEFAULT_PRESET = "1h"

const nodeDetailSearchSchema = Schema.Struct(TimeRangeSearchFields)

export const Route = createFileRoute("/infra/kubernetes/nodes/$nodeName")({
	component: NodeDetailPage,
	validateSearch: Schema.toStandardSchemaV1(nodeDetailSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const METRIC_OPTIONS = [
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "uptime", label: "Uptime" },
] as const satisfies ReadonlyArray<{ value: NodeInfraMetric; label: string }>

function NodeDetailPage() {
	const { nodeName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const [metric, setMetric] = useState<NodeInfraMetric>("cpu_usage")

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const bucketSeconds = bucketSecondsForRange(startTime, endTime)

	const summaryResult = useAtomValue(
		nodeDetailSummaryResultAtom({ data: { nodeName, startTime, endTime } }),
	)
	const podsResult = useAtomValue(
		listPodsResultAtom({ data: { nodeNames: [nodeName], startTime, endTime, limit: 200 } }),
	)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const rightPanel = summary ? (
		<ResourceAttributesCard icon={ServerIcon}>
			<DetailRail.MetaRow label="k8s.node.name" value={summary.nodeName} />
			<DetailRail.MetaRow label="k8s.node.uid" value={summary.nodeUid} />
			<DetailRail.MetaRow label="k8s.kubelet.version" value={summary.kubeletVersion} />
			<DetailRail.MetaRow label="container.runtime" value={summary.containerRuntime} />
		</ResourceAttributesCard>
	) : null

	return (
		<KubernetesShell
			view="nodes"
			trail={[{ label: nodeName }]}
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
					title={<span className="font-mono">{nodeName}</span>}
					description="Node metrics from the kubelet stats receiver."
					meta={
						summary ? (
							<>
								{summary.kubeletVersion && (
									<HeroChip>kubelet {summary.kubeletVersion}</HeroChip>
								)}
								{summary.containerRuntime && (
									<HeroChip>runtime {summary.containerRuntime}</HeroChip>
								)}
							</>
						) : undefined
					}
				/>

				{summary ? (
					<StatRail columns={3}>
						<StatRailItem
							eyebrow="CPU cores"
							value={Number.isFinite(summary.cpuUsage) ? summary.cpuUsage.toFixed(2) : "—"}
							compact
						/>
						<StatRailItem eyebrow="Uptime" value={formatUptime(summary.uptime)} compact />
						<StatRailItem eyebrow="Kubelet" value={summary.kubeletVersion || "—"} compact />
					</StatRail>
				) : (
					<NoMetricsMessage noun="node" />
				)}

				<div className="space-y-3">
					<SegmentPivot
						ariaLabel="Metric"
						options={METRIC_OPTIONS}
						value={metric}
						onChange={setMetric}
					/>
					<NodeDetailChart
						nodeName={nodeName}
						metric={metric}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
					/>
				</div>

				<div className="space-y-3">
					<SectionHeading as="h3" title="Pods on this node" />
					{Result.builder(podsResult)
						.onSuccess((r) => {
							const pods = r.data
							if (pods.length === 0) {
								return (
									<EmptyMessage dashed className="py-12">
										No pods reporting on this node in the selected window.
									</EmptyMessage>
								)
							}
							return (
								<PodTable
									pods={pods}
									timeSearch={pickTimeRangeSearch(search)}
									referenceTime={endTime}
								/>
							)
						})
						.orElse(() => null)}
				</div>
			</div>
		</KubernetesShell>
	)
}
