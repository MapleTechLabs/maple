import { singleChartHost } from "./chart-host-base"
import { buildLogsVolume } from "./definitions/logs-volume"

/** A host that draws only `ChartSpec.LogsVolume`, for pages that ship no other chart (the landing). */
export const createChartHost = singleChartHost("LogsVolume", buildLogsVolume)
