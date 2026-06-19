import type { ChartConfig } from "../../ui/chart"
import { resolveSeriesColor } from "../../../lib/semantic-series-colors"

export function buildChartConfig(
	data: Record<string, unknown>[],
	nameKey = "name",
): { config: ChartConfig; data: Record<string, unknown>[] } {
	const config: ChartConfig = {}
	const coloredData = data.map((item, i) => {
		const name = String(item[nameKey] ?? `item-${i}`)
		const key = name.toLowerCase().replace(/[^a-z0-9]/g, "-")
		config[key] = { label: name, color: resolveSeriesColor(name, i) }
		return { ...item, fill: `var(--color-${key})` }
	})
	return { config, data: coloredData }
}
