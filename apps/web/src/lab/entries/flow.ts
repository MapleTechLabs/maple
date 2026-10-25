import { Effect, Schema } from "effect"
import * as TraceFlow from "../../service-map/trace-flow/trace-flow"
import { FLOW_LAB_GRAPH, pageBody } from "../flow-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/flow`: the flow view lab inside the real shell.

const updateFlow = TraceFlow.update(FLOW_LAB_GRAPH)

export const lab = defineShellLab("Trace flow", {
	Model: TraceFlow.Model,
	Message: TraceFlow.Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init: () => ({ model: TraceFlow.init() }),
	update: (model, message) => ({ model: updateFlow(model, message) }),
	view: (model, h) => pageBody(h, model, (message) => message),
	currentPath: "/lab/flow",
	breadcrumbs: [{ label: "Flow Lab" }],
})
