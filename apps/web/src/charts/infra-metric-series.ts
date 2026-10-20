import {
	transformRows as transformRowsWith,
	type TransformedPoint,
} from "../components/infra/chart-units"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

// What `InfraMetricChart`'s callers read besides `chart-units`: the long-form pivot, colours and
// the tokens they resolve.

export {
	type ChartUnit,
	chartBucketSeconds,
	formatValueWithUnit,
	UNNAMED_SERIES_KEY,
} from "../components/infra/chart-units"

export type InfraPoint = TransformedPoint

export type LongRow = Readonly<{ bucket: string; attributeValue: string; value: number }>

/** `transformRows`: long-form rows pivoted into one point per bucket, keyed by series. */
export const transformRows = (rows: ReadonlyArray<LongRow>) => transformRowsWith(rows, () => "")

/** Every series' colour token: semantic names first, then the stable identity hash. */
export const seriesColorTokens = (series: ReadonlyArray<string>): ReadonlyMap<string, string> =>
	resolveSeriesColors(series)

/** Tokens `resolveSeriesColors` and the chart chrome can name, resolved once per theme by the page. */
export const INFRA_CHART_TOKENS: ReadonlyArray<string> = [
	"--border",
	"--background",
	"--destructive",
	"--chart-1",
	"--chart-p50",
	"--chart-p95",
	"--chart-p99",
	"--severity-info",
	"--severity-warn",
	"--severity-error",
	"--muted-foreground",
	"--color-severity-trace",
	"--color-severity-debug",
	"--color-severity-info",
	"--color-severity-warn",
	"--color-severity-error",
	"--color-severity-fatal",
	"--color-muted-foreground",
]

/** Buckets with no finite value for any series plot nothing, so they count as empty too. */
export const hasPlottableValue = (rows: ReadonlyArray<LongRow>): boolean =>
	rows.some((row) => Number.isFinite(row.value))
