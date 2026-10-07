import { afterAll, beforeAll } from "vitest"
import { Effect } from "effect"
import { McpToolExecutor } from "../dispatcher"
import { describeEval, ToolCallScorer, type TaskResult } from "./harness"
import { hasEvalCredentials } from "./model"
import { FIXTURES, runToolLoop } from "./utils"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"
import { makeEvalRuntime, type EvalRuntime } from "./eval-runtime"
import { OutputContainsScorer } from "./scorers"
import { LARGE_TRACE_SPAN_COUNT } from "./fixtures"

let rt: EvalRuntime | undefined

beforeAll(() => {
	if (!hasEvalCredentials()) return
	installFakeWarehouse()
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	if (rt) await rt.dispose()
})

const MAX_STEPS = 6

// Full-execution eval: the model actually calls inspect_trace, which runs end
// to end against the fake warehouse (150-span trace). Verifies the Part-1
// bounded-overview behavior surfaces through a real model + the real renderer.
describeEval("observability tool execution (fake warehouse)", {
	data: [
		{
			input: `Inspect trace ${FIXTURES.traceId} and tell me where the time went.`,
			expectedTools: [{ name: "inspect_trace" }],
		},
	],
	task: async (input: string): Promise<TaskResult> => {
		if (rt === undefined) throw new Error("eval runtime was not built")
		const transcript = await rt.runtime.runPromise(
			McpToolExecutor.pipe(Effect.flatMap((executor) => runToolLoop(executor, input, MAX_STEPS))),
		)
		// The rendered tool output joins the reply, so OutputContainsScorer sees what the model was shown.
		return {
			output: `${transcript.toolOutputs.join("\n")}\n${transcript.text}`,
			toolCalls: transcript.toolCalls,
		}
	},
	scorers: [
		ToolCallScorer({ requireAll: false }),
		OutputContainsScorer({
			mustContain: ["Showing", `of ${LARGE_TRACE_SPAN_COUNT} spans (errors and longest first)`],
		}),
	],
	threshold: 0.7,
})
