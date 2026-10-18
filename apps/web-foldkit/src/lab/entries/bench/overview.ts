import { BenchFlags, benchFlags, init, Model, update, view } from "../../bench/service-detail-bench"
import { defineLabWithFlags } from "../../define"

// `/lab/bench/overview`: apps/web mounts the same `ServiceDetailChartBench` here.

export const lab = defineLabWithFlags("Overview charts", {
	Model,
	Flags: BenchFlags,
	flags: benchFlags,
	init,
	update,
	view,
})
