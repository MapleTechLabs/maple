import { defineChartBench } from "../../bench/chart-bench"
import { view } from "../../bench/service-detail-bench"

// `/lab/bench/overview`: the service-detail chart bench.

export const lab = defineChartBench("Overview charts", view)
