import type { ComponentProps } from "react"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable } from "@/components/common/data-table"
import { SectionHeading } from "@/components/common/section-heading"
import { StatRailItem, StatRailItemSkeleton } from "@/components/common/stat-rail"
import { PodTable } from "@/components/infra/pod-table"
import { restartTone, summarizePodRestarts, type PodRestartRow } from "@/components/infra/pod-restarts"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { podRestartsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

/** A page of 50 pods with a few containers each, with headroom for sidecars. */
const PAGE_RESTARTS_LIMIT = 500

interface PodWindow {
	podName: string
	namespace?: string
	startTime: string
	endTime: string
}

const podRestartsAtom = ({ podName, namespace, startTime, endTime }: PodWindow) =>
	podRestartsResultAtom({ data: { podNames: [podName], namespace, startTime, endTime } })

/**
 * The pod table with each row's restarts beside its name. Restarts come from
 * the cluster collector, not the kubelet, so they load as a second query and
 * the table renders without them until it lands. Render only with a non-empty page.
 */
export function PodTableWithRestarts({
	startTime,
	endTime,
	...props
}: Omit<ComponentProps<typeof PodTable>, "restarts"> & { startTime: string; endTime: string }) {
	const result = useAtomValue(
		podRestartsResultAtom({
			data: {
				startTime,
				endTime,
				podNames: props.pods.map((pod) => pod.podName),
				limit: PAGE_RESTARTS_LIMIT,
			},
		}),
	)
	const restarts = Result.builder(result)
		.onSuccess((response) => summarizePodRestarts(response.data))
		.orElse(() => undefined)
	return <PodTable {...props} restarts={restarts} />
}

/** The restarts tile for the pod page's stat rail. */
export function PodRestartsStat(props: PodWindow) {
	const result = useAtomValue(podRestartsAtom(props))
	return Result.builder(result)
		.onInitial(() => <StatRailItemSkeleton />)
		.onError(() => <StatRailItem eyebrow="Restarts" value={EMPTY_VALUE} hint="unavailable" compact />)
		.onSuccess((response) => {
			// No rows means the cluster collector isn't reporting this pod, not zero restarts.
			if (response.data.length === 0) {
				return <StatRailItem eyebrow="Restarts" value={EMPTY_VALUE} hint="not reported" compact />
			}
			const summary = summarizePodRestarts(response.data).values().next().value
			const restarts = summary?.restarts ?? 0
			const reason = summary?.lastTerminatedReason ?? ""
			return (
				<StatRailItem
					eyebrow="Restarts"
					value={String(restarts)}
					hint={`of ${summary?.totalRestarts ?? 0} total`}
					subline={reason ? `Last terminated: ${reason}` : undefined}
					tone={restartTone(restarts, reason)}
					compact
				/>
			)
		})
		.render()
}

/** Per-container breakdown, shown once any container has restarted or terminated. */
export function PodContainerRestarts(props: PodWindow) {
	const result = useAtomValue(podRestartsAtom(props))
	const rows = Result.builder(result)
		.onSuccess((response) => response.data)
		.orElse(() => [])
	if (!rows.some((row) => row.totalRestarts > 0 || row.lastTerminatedReason !== "")) return null
	return (
		<div className="space-y-3">
			<SectionHeading as="h3" title="Container restarts" hint="most restarts first" />
			<DataTable.Root ariaLabel="Container restarts">
				<DataTable.Head>
					<ColumnHead label="Container" width="w-0 flex-1 min-w-[200px]" />
					<ColumnHead label="In window" align="right" width="w-[96px]" />
					<ColumnHead label="Total" align="right" width="w-[96px]" />
					<ColumnHead label="Last terminated" align="right" width="w-[160px]" />
				</DataTable.Head>
				{rows.map((row) => (
					<ContainerRow key={row.containerName} row={row} />
				))}
			</DataTable.Root>
		</div>
	)
}

function ContainerRow({ row }: { row: PodRestartRow }) {
	return (
		<div className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0">
			<span className="w-0 min-w-[200px] flex-1 truncate font-mono text-xs text-foreground">
				{row.containerName || EMPTY_VALUE}
			</span>
			<span
				className={cn(
					"w-[96px] text-right font-mono text-xs tabular-nums",
					TONE_TEXT[restartTone(row.restarts, row.lastTerminatedReason)],
				)}
			>
				{row.restarts}
			</span>
			<span className="w-[96px] text-right font-mono text-xs tabular-nums text-muted-foreground">
				{row.totalRestarts}
			</span>
			<span className="w-[160px] truncate text-right text-xs text-muted-foreground">
				{row.lastTerminatedReason || EMPTY_VALUE}
			</span>
		</div>
	)
}
