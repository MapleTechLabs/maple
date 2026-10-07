/**
 * Compare two eval runs on the tasks they share, as paired per-task differences.
 *
 *   bun run eval:compare .evals/runs/<runA> .evals/runs/<runB>
 *
 * A difference whose 95% interval crosses zero is not a difference. Paired comparison removes the
 * task-difficulty variance both runs share, which is why it beats comparing two pass@1 numbers.
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { comparePaired } from "../src/evals/stats"
import type { RunSummary } from "../src/evals/runner"

const [first, second] = process.argv.slice(2)
if (first === undefined || second === undefined) {
	console.error("usage: bun run eval:compare <runA> <runB>")
	process.exit(2)
}

const load = (dir: string): RunSummary => JSON.parse(readFileSync(join(resolve(dir), "summary.json"), "utf8"))

const a = load(first)
const b = load(second)
const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const signed = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`
const result = comparePaired(a.tallies, b.tallies)

console.log(`A: ${a.model} (${a.suite}, k=${a.k}) pass@1 ${pct(a.overall.passAt1.mean)}`)
console.log(`B: ${b.model} (${b.suite}, k=${b.k}) pass@1 ${pct(b.overall.passAt1.mean)}`)
console.log(
	`\nA − B over ${result.tasks} shared tasks: ${signed(result.delta)} (95% CI ${signed(result.low)} to ${signed(result.high)})`,
)
console.log(
	result.low > 0
		? "A is better."
		: result.high < 0
			? "B is better."
			: "No significant difference at this sample size.",
)
console.log(`\nA better on: ${result.aBetter.join(", ") || "none"}`)
console.log(`B better on: ${result.bBetter.join(", ") || "none"}`)

const perTrial = (summary: RunSummary) =>
	`${summary.cost.meanToolCalls.toFixed(1)} calls, ` +
	`${Math.round(summary.cost.inputTokens / Math.max(1, summary.cost.trials))} in / ` +
	`${Math.round(summary.cost.outputTokens / Math.max(1, summary.cost.trials))} out tokens, ` +
	`${(summary.cost.meanDurationMs / 1000).toFixed(1)} s, ${summary.cost.errored} errored`
console.log(`\nPer trial, A: ${perTrial(a)}`)
console.log(`Per trial, B: ${perTrial(b)}`)
