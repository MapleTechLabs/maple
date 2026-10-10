/**
 * Tool-use eval: each task is one production chat turn against the fake warehouse.
 *
 *   bun run eval:tools                         # production model, k=1
 *   EVAL_MODEL=anthropic/claude-haiku-5.5 EVAL_K=3 bun run eval:tools
 *   EVAL_TASKS=tag:negative,trace-tree bun run eval:tools
 *
 * Only regression-tier tasks gate: each must pass a majority of its trials. Capability tasks are
 * reported, never asserted. The full report is in the run's `summary.md`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { McpToolExecutor, type McpToolExecutorApi } from "../../mcp/dispatcher"
import { makeEvalRuntime, type EvalRuntime } from "../../mcp/__evals__/eval-runtime"
import {
	defaultTraceFixtures,
	installFakeWarehouse,
	restoreWarehouse,
} from "../../mcp/__evals__/fake-warehouse"
import { solveChatTurn } from "../chat-turn"
import { evalModel, hasEvalCredentials } from "../model"
import { renderSummary, runSettings, runSuite, selectTasks } from "../runner"
import { grade } from "../targets"
import { seedWorld, worldRules } from "../world"
import { infraFixtureRules } from "../../mcp/__evals__/infra-world"
import { TOOL_TASKS } from "./tasks"

const DEFAULT_MAX_TOOL_CALLS = 6

let rt: EvalRuntime | undefined
let executor: McpToolExecutorApi | undefined

beforeAll(async () => {
	if (!hasEvalCredentials()) return
	// The world answers the probes; the trace fixtures answer the trace tasks; anything else is empty.
	installFakeWarehouse(
		[...worldRules(), ...defaultTraceFixtures(), ...infraFixtureRules()],
		undefined,
		"empty",
	)
	rt = makeEvalRuntime()
	await seedWorld(rt)
	executor = await rt.runtime.runPromise(Effect.service(McpToolExecutor))
})

afterAll(async () => {
	restoreWarehouse()
	await rt?.dispose()
})

describe.skipIf(!hasEvalCredentials())("tool-use eval", () => {
	it("runs every selected task k times", { timeout: 60 * 60 * 1000 }, async () => {
		const settings = runSettings()
		const tasks = selectTasks(TOOL_TASKS, settings)
		const runtime = rt
		const toolExecutor = executor
		if (runtime === undefined || toolExecutor === undefined) throw new Error("eval runtime was not built")

		const summary = await Effect.runPromise(
			runSuite({
				suite: "tools",
				model: evalModel().model.name,
				tasks,
				k: settings.k,
				concurrency: settings.concurrency,
				trial: (task) =>
					solveChatTurn({
						executor: toolExecutor,
						tenant: runtime.tenant,
						text: task.input,
						maxToolCalls: task.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
					}).pipe(
						Effect.map((transcript) => ({
							transcript,
							grade: grade(task.expect, transcript.calls, transcript.answer),
						})),
					),
			}),
		)
		console.info(`\n${renderSummary(summary)}\n`)

		const regressions = summary.tallies.filter(
			(tally) =>
				tasks.find((task) => task.id === tally.task)?.tier === "regression" &&
				tally.passes * 2 <= tally.trials,
		)
		expect(
			regressions.map((tally) => `${tally.task} ${tally.passes}/${tally.trials}`),
			`regression tasks failing a majority of trials; see ${summary.dir}/summary.md`,
		).toEqual([])
	})
})
