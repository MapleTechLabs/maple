import { useMemo } from "react"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getServiceWorkloadsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ServiceWorkload } from "@/api/warehouse/service-infra"
import { MeterRows } from "@/components/infra/primitives/meter-rows"
import { SectionCard } from "./section-card"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@maple/ui/components/ui/item"
import { countLabel } from "@maple/ui/lib/format"

interface ServiceWorkloadsPanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	/**
	 * True when the page has an environment filter active. Workload identity
	 * comes from span resource attributes with no environment key, so the panel
	 * cannot honor the filter — it labels itself "all environments" instead.
	 */
	envFilterActive?: boolean
}

const KIND_LABEL: Record<ServiceWorkload["workloadKind"], string> = {
	deployment: "Deployment",
	statefulset: "StatefulSet",
	daemonset: "DaemonSet",
	unknown: "Workload",
} satisfies Record<ServiceWorkload["workloadKind"], string>

/**
 * Kubernetes footprint for this service: the workload(s) it runs as, pod count,
 * and average CPU/memory limit utilization over the window. Workload identity
 * comes from span resource attributes (env-agnostic). Quiet — renders nothing
 * while loading, on error, or when the service carries no k8s context.
 */
export function ServiceWorkloadsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	envFilterActive,
}: ServiceWorkloadsPanelProps) {
	const result = useRefreshableAtomValue(
		getServiceWorkloadsResultAtom({
			data: {
				services: [serviceName],
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
			},
		}),
	)

	const workloads = useMemo<ServiceWorkload[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => [...r.workloads])
				.orElse(() => []),
		[result],
	)

	if (workloads.length === 0) return null

	const isWaiting = Result.isSuccess(result) && result.waiting

	return (
		<SectionCard
			title="Kubernetes"
			action={
				envFilterActive ? (
					<span className="text-3xs text-muted-foreground/60">all environments</span>
				) : undefined
			}
			className={refreshingClass(isWaiting)}
		>
			<ul className="divide-y">
				{workloads.map((workload) => (
					<Item
						key={`${workload.workloadKind}:${workload.namespace}:${workload.workloadName}`}
						render={<li />}
						variant="flush"
						className="gap-x-3 gap-y-1.5 px-4 py-2.5"
					>
						<ItemContent className="gap-0 leading-tight">
							<ItemTitle className="block truncate font-mono text-xs font-normal text-foreground">
								{workload.workloadName}
							</ItemTitle>
							<ItemDescription className="truncate text-3xs text-muted-foreground/60">
								{KIND_LABEL[workload.workloadKind]} · {workload.namespace}
								{workload.clusterName ? ` · ${workload.clusterName}` : ""}
							</ItemDescription>
						</ItemContent>
						<ItemActions className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
							{countLabel(workload.podCount, "pod")}
						</ItemActions>
						{(workload.avgCpuLimitUtilization != null ||
							workload.avgMemoryLimitUtilization != null) && (
							<MeterRows
								className="max-w-[280px] basis-full"
								meters={[
									workload.avgCpuLimitUtilization != null && {
										label: "CPU",
										fraction: workload.avgCpuLimitUtilization,
									},
									workload.avgMemoryLimitUtilization != null && {
										label: "MEM",
										fraction: workload.avgMemoryLimitUtilization,
									},
								].filter((meter) => meter !== false)}
							/>
						)}
					</Item>
				))}
			</ul>
		</SectionCard>
	)
}
