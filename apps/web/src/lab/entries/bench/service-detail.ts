import { defineChartBench } from "../../bench/chart-bench"
import { view } from "../../bench/service-detail-bench"

// `/lab/bench/service-detail`: the service-detail chart grid on synthetic rows.

export const lab = defineChartBench("Service detail charts", view)
