import { singleChartHost } from "./chart-host-base"
import { buildOccurrences } from "./definitions/occurrences"

/** A host that draws only `ChartSpec.Occurrences`, for pages that ship no other chart (the landing). */
export const createChartHost = singleChartHost("Occurrences", buildOccurrences)
