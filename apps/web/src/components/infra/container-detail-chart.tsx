import { useAtomValue } from "@/lib/effect-atom"

import { ChartError, ChartLoading } from "@maple/ui/components/charts"

import { containerInfraTimeseriesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ContainerInfraMetric } from "@/api/warehouse/infra"
import { K8sMetricChartView } from "./k8s-detail-chart"
import { displayError } from "@/lib/error-messages"
import { ResultView } from "@/components/common/result-view"

const CHART_HEIGHT = 280

const CONTAINER_METRIC_LABELS = {
	cpu: "CPU",
	memory_percent: "Memory / limit",
	memory_bytes: "Memory usage",
	network: "Network I/O",
	disk_io: "Block I/O",
	uptime: "Uptime",
} satisfies Record<ContainerInfraMetric, string>

interface ContainerDetailChartProps {
	containerName: string
	hostName?: string
	metric: ContainerInfraMetric
	startTime: string
	endTime: string
	bucketSeconds?: number
	syncId?: string
}

export function ContainerDetailChart({
	containerName,
	hostName,
	metric,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: ContainerDetailChartProps) {
	const result = useAtomValue(
		containerInfraTimeseriesResultAtom({
			data: { containerName, hostName, metric, startTime, endTime, bucketSeconds },
		}),
	)

	return (
		<ResultView
			result={result}
			loading={<ChartLoading variant="area" height={CHART_HEIGHT} />}
			error={(err) => <ChartError height={CHART_HEIGHT}>{displayError(err).message}</ChartError>}
		>
			{(response, { waiting }) => (
				<K8sMetricChartView
					rows={response.data}
					unit={response.unit}
					seriesLabel={CONTAINER_METRIC_LABELS[metric]}
					showThreshold={metric === "cpu" || metric === "memory_percent"}
					waiting={waiting}
					syncId={syncId}
					chartId={`container-${metric}`}
				/>
			)}
		</ResultView>
	)
}
