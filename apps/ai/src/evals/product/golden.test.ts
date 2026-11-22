/**
 * The golden run: each scenario's ideal tool calls, with no model, against the seeded engine.
 *
 * A scenario passes when every fact of its answer is in the text those calls rendered, which is
 * what a model would have read. So this proves three things at once: the SQL computes the number
 * the rows give, the tool shows it, and it takes that many calls. The table it prints is the
 * scorecard for "can the tools get the right data quickly".
 *
 * Needs a libchdb and bun; skipped where there is none, and required under MAPLE_REQUIRE_LIBCHDB.
 * `PRODUCT_SCENARIOS_SHOW=<scenario id>` prints the pages a scenario's calls rendered.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Option, Array as Arr, String as Str } from "effect"
import { markdown, runToolDirect } from "../../mcp/__evals__/eval-runtime"
import { grade } from "../targets"
import { chdbAvailable, chdbRequired } from "./chdb-warehouse"
import { startProductWorld, type ProductWorld } from "./runtime"
import { productScenarios, type Scenario } from "./scenarios"
import { makeWorld } from "./world"

/** A direct tool path on a few thousand rows has no reason to take longer. */
const SCENARIO_BUDGET_MS = 5_000

// The ids are fixed by the scenario list, so the cases are known before the engine is up.
const IDS = Arr.map(
	Arr.filter(productScenarios(makeWorld(Date.now())), (scenario) => scenario.golden !== undefined),
	(scenario) => scenario.id,
)

interface Row {
	readonly id: string
	readonly calls: number
	readonly ms: number
	readonly pass: boolean
}

let live: ProductWorld | undefined
const rows: Array<Row> = []

describe.skipIf(!chdbRequired() && !chdbAvailable())("product scenarios: golden tool paths", () => {
	beforeAll(async () => {
		live = await startProductWorld()
	}, 120_000)

	afterAll(async () => {
		const width = Math.max(...Arr.map(rows, (row) => row.id.length), 8)
		console.info(
			`\n${Arr.join(
				[
					`${Str.padEnd(width)("scenario")}  calls      ms  result`,
					...Arr.map(
						rows,
						(row) =>
							`${Str.padEnd(width)(row.id)}  ${Str.padStart(5)(String(row.calls))}  ${Str.padStart(6)(String(row.ms))}  ${row.pass ? "ok" : "FAIL"}`,
					),
				],
				"\n",
			)}\n`,
		)
		await live?.dispose()
	})

	it.each(IDS)("%s", async (id) => {
		const world = live
		if (world === undefined) throw new Error("the product world did not start")
		const scenario: Scenario | undefined = Option.getOrUndefined(
			Arr.findFirst(world.scenarios, (entry) => entry.id === id),
		)
		const golden = scenario?.golden
		if (scenario === undefined || golden === undefined) throw new Error(`no golden path for ${id}`)

		const started = Date.now()
		const shown: Array<string> = []
		for (const call of golden) {
			const result = await runToolDirect(world.rt, call.tool, call.args, "chat")
			expect(result.isError, `${call.tool} failed: ${markdown(result)}`).not.toBe(true)
			shown.push(markdown(result))
		}
		const ms = Date.now() - started
		const page = Arr.join(shown, "\n\n")
		const result = grade(scenario.facts, [], page)
		rows.push({ id, calls: golden.length, ms, pass: result.pass })
		// PRODUCT_SCENARIOS_SHOW=<id> prints what the model would read for that scenario.
		if (process.env.PRODUCT_SCENARIOS_SHOW === id) console.info(`\n${page}\n`)

		expect(result.pass, `${result.explanation}\n\n${page}`).toBe(true)
		expect(golden.length).toBeLessThanOrEqual(scenario.maxToolCalls)
		expect(ms).toBeLessThan(SCENARIO_BUDGET_MS)
	})
})
