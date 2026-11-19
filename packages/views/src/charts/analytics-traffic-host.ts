import { singleChartHost } from "./chart-host-base"
import { buildAnalyticsTraffic } from "./definitions/analytics-traffic"

/** A host that draws only `ChartSpec.AnalyticsTraffic`, for pages that ship no other chart (the landing). */
export const createChartHost = singleChartHost("AnalyticsTraffic", buildAnalyticsTraffic)
