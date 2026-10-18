import { BenchFlags, benchFlags, init, Model, update, view } from "../../bench/service-detail-bench"
import { defineLabWithFlags } from "../../define"

// `/lab/bench/service-detail`: the service-detail chart grid on synthetic rows.

export const lab = defineLabWithFlags("Service detail charts", {
	Model,
	Flags: BenchFlags,
	flags: benchFlags,
	init,
	update,
	view,
})
