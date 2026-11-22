/**
 * Configuration eval: each task is one production chat turn, asked by an org admin in the
 * configured org of `world.ts`, graded on the change the agent proposes.
 *
 *   bun run eval:config
 *   EVAL_K=3 EVAL_TASKS=tag:gap bun run eval:config
 *
 * Every task is capability tier, so the run reports and never gates. See `../README.md`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Console, Effect } from "effect"
import { McpToolExecutor, type McpToolExecutorApi } from "../../mcp/dispatcher"
import { asCaller, makeEvalRuntime, type EvalRuntime } from "../../mcp/__evals__/eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "../../mcp/__evals__/fake-warehouse"
import { solveChatTurn } from "../chat-turn"
import { evalModel, hasEvalCredentials } from "../model"
import { renderSummary, runSettings, runSuite, selectTasks } from "../runner"
import { grade } from "../targets"
import { worldRules } from "../world"
import { CONFIG_TASKS } from "./tasks"
import { ADMIN_CALLER, seedConfigWorld } from "./world"

const DEFAULT_MAX_TOOL_CALLS = 8

let rt: EvalRuntime | undefined
let executor: McpToolExecutorApi | undefined

beforeAll(async () => {
	if (!hasEvalCredentials()) return
	// The services the tasks name exist, so a probe for one finds it; nothing else is modeled.
	installFakeWarehouse(worldRules(), undefined, "empty")
	const base = makeEvalRuntime()
	await seedConfigWorld(base)
	rt = asCaller(base, ADMIN_CALLER)
	executor = await base.runtime.runPromise(Effect.service(McpToolExecutor))
})

afterAll(async () => {
	restoreWarehouse()
	await rt?.dispose()
})

describe.skipIf(!hasEvalCredentials())("configuration eval", () => {
	it("runs every selected task k times", { timeout: 60 * 60 * 1000 }, async () => {
		const settings = runSettings()
		const tasks = selectTasks(CONFIG_TASKS, settings)
		const runtime = rt
		const toolExecutor = executor
		if (runtime === undefined || toolExecutor === undefined) throw new Error("eval runtime was not built")

		const summary = await Effect.runPromise(
			runSuite({
				suite: "config",
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
			}).pipe(Effect.tap((result) => Console.info(`\n${renderSummary(result)}\n`))),
		)
		expect(summary.cost.trials).toBe(tasks.length * settings.k)
	})
})
