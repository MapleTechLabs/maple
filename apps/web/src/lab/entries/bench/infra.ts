import { defineChartBench } from "../../bench/chart-bench"
import { view } from "../../bench/infra-bench"

// `/lab/bench/infra`: the infra detail charts in one linked-cursor group.

export const lab = defineChartBench("Infra charts", view)
