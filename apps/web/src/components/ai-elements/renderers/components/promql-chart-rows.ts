import type { StructuredToolData } from "@maple/domain"

type PromQlSeries = StructuredToolData<"query_gcp_promql">["series"][number]

const seriesKey = (labels: PromQlSeries["labels"]): string => {
	const entries = Object.entries(labels).filter(([key]) => key !== "__name__")
	return entries.length === 0 ? "value" : entries.map(([key, value]) => `${key}=${value}`).join(", ")
}

/** PromQL series (`[epoch seconds, value]` points) as the `{ bucket, series }` rows `QueryChart` draws. */
export function promQlChartRows(
	series: ReadonlyArray<PromQlSeries>,
): Array<{ bucket: string; series: Record<string, number> }> {
	const rows = new Map<number, Record<string, number>>()
	for (const one of series) {
		const key = seriesKey(one.labels)
		for (const [seconds, value] of one.points) {
			const row = rows.get(seconds) ?? {}
			row[key] = value
			rows.set(seconds, row)
		}
	}
	return [...rows.entries()]
		.sort(([a], [b]) => a - b)
		.map(([seconds, values]) => ({ bucket: new Date(seconds * 1000).toISOString(), series: values }))
}
