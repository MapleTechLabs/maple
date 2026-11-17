import { singleChartHost } from "./chart-host-base"
import { buildQueryBuilderBar } from "./definitions/bar"

/** A host that draws only `ChartSpec.QueryBuilderBar`, for pages that ship no other chart (the landing). */
export const createChartHost = singleChartHost("QueryBuilderBar", buildQueryBuilderBar)
