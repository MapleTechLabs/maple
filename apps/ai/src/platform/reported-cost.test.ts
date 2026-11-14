import { assert, describe, it } from "@effect/vitest"
import { reportedCostOf } from "./genai-spans"

/** The token counts every OpenRouter usage carries; they do not change the price. */
const tokens = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 }

const upstream = (usd: number) => ({
	upstream_inference_cost: usd,
	upstream_inference_prompt_cost: usd,
	upstream_inference_completions_cost: 0,
})

describe("reportedCostOf", () => {
	it("is OpenRouter's cost for a call on its own credits", () => {
		const usage = { ...tokens, cost: 0.0042, cost_details: upstream(0.004) }
		assert.strictEqual(reportedCostOf({ openrouter: { usage } }), 0.0042)
	})

	// A BYOK call's `cost` is only OpenRouter's fee: the provider's price would be missed otherwise.
	it("adds the provider's price to a BYOK call", () => {
		const withFee = { ...tokens, cost: 0.0002, is_byok: true, cost_details: upstream(0.004) }
		assert.closeTo(reportedCostOf({ openrouter: { usage: withFee } }) ?? Number.NaN, 0.0042, 1e-12)
		const noFee = { ...tokens, cost: 0, is_byok: true, cost_details: upstream(0.0031) }
		assert.strictEqual(reportedCostOf({ openrouter: { usage: noFee } }), 0.0031)
	})

	it("is unknown without a cost, never free", () => {
		const usage = { ...tokens, is_byok: true, cost_details: upstream(0.004) }
		assert.isUndefined(reportedCostOf({ openrouter: { usage } }))
		assert.isUndefined(reportedCostOf(undefined))
	})
})
