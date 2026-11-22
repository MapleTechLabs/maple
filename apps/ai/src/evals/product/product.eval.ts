/**
 * Product analytics eval: each scenario is one production chat turn that gets only the question,
 * against the seeded engine. The answer is graded on the facts the rows give, so a trial passes
 * only when the agent found the right number, whichever tools it used.
 *
 *   bun run eval:product                         # production model, k=1
 *   EVAL_MODEL=anthropic/claude-haiku-5.5 EVAL_K=3 bun run eval:product
 *   EVAL_TASKS=tag:accounts,signup-funnel bun run eval:product
 *
 * Beside the usual summary it prints, per scenario, how many tool calls and seconds a trial took:
 * "right" and "quickly" are both the point. Needs OPENROUTER_API_KEY, a libchdb and bun.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Array as Arr, String as Str } from "effect"
import { McpToolExecutor, type McpToolExecutorApi } from "../../mcp/dispatcher"
import { solveChatTurn, type Transcript } from "../chat-turn"
import { evalModel, hasEvalCredentials } from "../model"
import { renderSummary, runSettings, runSuite, selectTasks } from "../runner"
import { grade } from "../targets"
import { chdbAvailable } from "./chdb-warehouse"
import { startProductWorld, type ProductWorld } from "./runtime"

let live: ProductWorld | undefined
let executor: McpToolExecutorApi | undefined

const runnable = hasEvalCredentials() && chdbAvailable()

beforeAll(async () => {
	if (!runnable) return
	live = await startProductWorld()
	executor = await live.rt.runtime.runPromise(Effect.service(McpToolExecutor))
}, 120_000)

afterAll(async () => {
	await live?.dispose()
})

const mean = (values: ReadonlyArray<number>): number =>
	values.length === 0 ? 0 : Arr.reduce(values, 0, (sum, value) => sum + value) / values.length

describe.skipIf(!runnable)("product analytics eval", () => {
	it("runs every selected scenario k times", { timeout: 60 * 60 * 1000 }, async () => {
		const world = live
		const toolExecutor = executor
		if (world === undefined || toolExecutor === undefined)
			throw new Error("the product world did not start")
		const settings = runSettings()
		const tasks = selectTasks(world.scenarios, settings)
		const trials = new Map<string, Array<{ readonly pass: boolean; readonly transcript: Transcript }>>()

		const summary = await Effect.runPromise(
			runSuite({
				suite: "product",
				model: evalModel().model.name,
				tasks,
				k: settings.k,
				concurrency: settings.concurrency,
				trial: (task) =>
					solveChatTurn({
						executor: toolExecutor,
						tenant: world.rt.tenant,
						text: task.question,
						maxToolCalls: task.maxToolCalls,
					}).pipe(
						Effect.map((transcript) => {
							const result = grade(task.facts, transcript.calls, transcript.answer)
							trials.set(task.id, [
								...(trials.get(task.id) ?? []),
								{ pass: result.pass, transcript },
							])
							return { transcript, grade: result }
						}),
					),
			}),
		)
		process.stdout.write(`\n${renderSummary(summary)}\n\n`)

		const width = Math.max(...Arr.map(tasks, (task) => task.id.length), 8)
		process.stdout.write(
			`${Arr.join(
				[
					`${Str.padEnd(width)("scenario")}  passed  calls  seconds  tools`,
					...Arr.map(tasks, (task) => {
						const runs = trials.get(task.id) ?? []
						const passed = Arr.filter(runs, (run) => run.pass).length
						const calls = mean(Arr.map(runs, (run) => run.transcript.calls.length))
						const seconds = mean(Arr.map(runs, (run) => run.transcript.durationMs)) / 1_000
						const tools = [
							...new Set(
								Arr.flatMap(runs, (run) =>
									Arr.map(run.transcript.calls, (call) => call.tool),
								),
							),
						]
						return `${Str.padEnd(width)(task.id)}  ${Str.padStart(6)(`${passed}/${runs.length}`)}  ${Str.padStart(5)(calls.toFixed(1))}  ${Str.padStart(7)(seconds.toFixed(1))}  ${Arr.join(tools, ", ")}`
					}),
				],
				"\n",
			)}\n`,
		)

		const regressions = Arr.filter(
			summary.tallies,
			(tally) =>
				Arr.some(tasks, (task) => task.id === tally.task && task.tier === "regression") &&
				tally.passes * 2 <= tally.trials,
		)
		expect(
			Arr.map(regressions, (tally) => `${tally.task} ${tally.passes}/${tally.trials}`),
			`regression scenarios failing a majority of trials; see ${summary.dir}/summary.md`,
		).toEqual([])
	})
})
