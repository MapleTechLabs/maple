import { defineChartBench } from "../../bench/chart-bench"
import { viewWithMarkers } from "../../bench/service-detail-bench"

// `/lab/bench/service-detail-markers`: the service-detail grid with deploy markers, one of them grouped.

export const lab = defineChartBench("Service detail markers", viewWithMarkers)
