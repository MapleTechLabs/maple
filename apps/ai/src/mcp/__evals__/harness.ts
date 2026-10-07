import { describe, expect, it } from "vitest"
import { hasEvalCredentials } from "./model"

/**
 * The eval harness: a case table, a task that runs the model, and scorers averaged against a
 * threshold. Plain vitest, so evals carry no LLM SDK of their own and run the model through the
 * same Effect AI stack the agents use.
 */

export interface ToolCall {
	readonly name: string
	readonly arguments: Readonly<Record<string, unknown>>
}

interface ExpectedTool {
	readonly name: string
	/** Matched fuzzily: a subset of the actual arguments, strings compared case-insensitively. */
	readonly arguments?: Readonly<Record<string, unknown>>
}

interface EvalCase {
	readonly input: string
	readonly name?: string
	readonly expectedTools?: ReadonlyArray<ExpectedTool>
}

export interface TaskResult {
	readonly output: string
	readonly toolCalls: ReadonlyArray<ToolCall>
}

interface Score {
	readonly score: number
	readonly rationale: string
}

export interface Scorer<Case extends EvalCase = EvalCase> {
	readonly name: string
	readonly score: (run: Case & TaskResult) => Score
}

interface EvalOptions<Case extends EvalCase> {
	readonly data: ReadonlyArray<Case>
	readonly task: (input: string) => Promise<TaskResult>
	readonly scorers: ReadonlyArray<Scorer<Case>>
	/** The mean score a case must reach. */
	readonly threshold: number
}

const EVAL_TIMEOUT_MS = 60_000

/** One test per case; skips rather than fails without an OpenRouter key, so `bun run eval` stays green. */
export const describeEval = <Case extends EvalCase>(name: string, options: EvalOptions<Case>): void => {
	if (!hasEvalCredentials()) {
		describe.skip(`[eval] ${name}`, () => {
			it("skipped: set OPENROUTER_API_KEY to run evals", () => {})
		})
		return
	}
	describe(name, () => {
		options.data.forEach((evalCase) => {
			it(evalCase.name ?? evalCase.input, { timeout: EVAL_TIMEOUT_MS }, async () => {
				const result = await options.task(evalCase.input)
				const scores = options.scorers.map((scorer) => ({
					name: scorer.name,
					...scorer.score({ ...evalCase, ...result }),
				}))
				const mean = scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length
				const report = scores
					.map((entry) => `${entry.name} ${entry.score.toFixed(2)}: ${entry.rationale}`)
					.join("\n")
				console.info(`[eval] ${mean.toFixed(2)} ${evalCase.name ?? evalCase.input}\n${report}`)
				expect(mean, `${report}\n\nOutput: ${result.output}`).toBeGreaterThanOrEqual(
					options.threshold,
				)
			})
		})
	})
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const NUMERIC_TOLERANCE = 1e-3

/**
 * Expected is a pattern over actual: object keys are a subset, arrays match in any order, strings
 * match case-insensitively either way round as substrings, numbers within a relative tolerance.
 */
export const fuzzyMatch = (expected: unknown, actual: unknown): boolean => {
	if (typeof expected === "string" && typeof actual === "string") {
		const want = expected.toLowerCase()
		const got = actual.toLowerCase()
		return got.includes(want) || want.includes(got)
	}
	if (typeof expected === "number" && typeof actual === "number") {
		return (
			Math.abs(expected - actual) <= Math.max(Math.abs(expected) * NUMERIC_TOLERANCE, NUMERIC_TOLERANCE)
		)
	}
	if (Array.isArray(expected) && Array.isArray(actual)) {
		const used = new Set<number>()
		return expected.every((item) => {
			const index = actual.findIndex((candidate, at) => !used.has(at) && fuzzyMatch(item, candidate))
			if (index === -1) return false
			used.add(index)
			return true
		})
	}
	if (isRecord(expected) && isRecord(actual)) {
		return Object.entries(expected).every(
			([key, value]) => key in actual && fuzzyMatch(value, actual[key]),
		)
	}
	return expected === actual
}

/**
 * Did the model call the expected tools with matching arguments? Order is ignored and extra calls
 * are allowed. With `requireAll`, any miss scores 0; without it, the score is the fraction matched.
 */
export const ToolCallScorer = (config: { readonly requireAll?: boolean } = {}): Scorer => ({
	name: "ToolCallScorer",
	score: ({ expectedTools = [], toolCalls }) => {
		if (expectedTools.length === 0) return { score: 1, rationale: "no tool calls expected" }
		if (toolCalls.length === 0) {
			return { score: 0, rationale: `expected ${expectedTools.length} tool(s) but none were called` }
		}
		const used = new Set<number>()
		const missing = expectedTools.filter((expected) => {
			const index = toolCalls.findIndex(
				(call, at) =>
					!used.has(at) &&
					call.name === expected.name &&
					(expected.arguments === undefined || fuzzyMatch(expected.arguments, call.arguments)),
			)
			if (index === -1) return true
			used.add(index)
			return false
		})
		const called = toolCalls.map((call) => call.name).join(", ")
		if (missing.length === 0) return { score: 1, rationale: `all expected tools called (${called})` }
		const issues = missing
			.map((tool) =>
				tool.arguments !== undefined && toolCalls.some((call) => call.name === tool.name)
					? `${tool.name} called with wrong arguments`
					: `missing ${tool.name}`,
			)
			.join("; ")
		const matched = expectedTools.length - missing.length
		return {
			score: (config.requireAll ?? true) ? 0 : matched / expectedTools.length,
			rationale: `${issues} (called: ${called})`,
		}
	},
})
