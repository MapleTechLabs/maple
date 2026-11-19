import { singleChartHost } from "./chart-host-base"
import { buildQueryBuilderArea } from "./definitions/area"

/** A host that draws only `ChartSpec.QueryBuilderArea`, for pages that ship no other chart (the landing). */
export const createChartHost = singleChartHost("QueryBuilderArea", buildQueryBuilderArea)
