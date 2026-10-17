import type { V2SourceUsage } from "@maple/domain/http/v2"
import { QueryBuilderBarChart } from "@maple/ui/components/charts"

const HOUR_MS = 3_600_000

/** 24 hourly rows ending at the window's end; hours the API omitted count as zero. */
export const usageRows = (usage: V2SourceUsage): Record<string, unknown>[] => {
	const end = Math.floor(new Date(usage.window_end).getTime() / HOUR_MS) * HOUR_MS
	const byHour = new Map(usage.buckets.map((bucket) => [new Date(bucket.hour).getTime(), bucket]))
	return Array.from({ length: 24 }, (_, index) => {
		const hour = end - (23 - index) * HOUR_MS
		const bucket = byHour.get(hour)
		return { bucket: new Date(hour).toISOString(), Spans: bucket?.spans ?? 0, Logs: bucket?.logs ?? 0 }
	})
}

export function UsageChart({ usage }: { usage: V2SourceUsage }) {
	return (
		<div className="h-48 w-full">
			<QueryBuilderBarChart
				data={usageRows(usage)}
				stacked
				legend="visible"
				className="h-full w-full"
			/>
		</div>
	)
}
