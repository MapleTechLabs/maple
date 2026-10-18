import { defineChartBench } from "../../bench/chart-bench"
import { view } from "../../bench/service-detail-bench"

// `/lab/bench/overview`: apps/web mounts the same `ServiceDetailChartBench` here.

export const lab = defineChartBench("Overview charts", view)
