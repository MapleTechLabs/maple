/**
 * How a run's model calls become AI credit charges.
 *
 * Autumn prices one `track_tokens` charge from its own total input, and switches a model to its
 * long-context rate past a tier (as low as 32k on models.dev). So calls are merged only while the
 * sum stays under every tier; a merged turn would otherwise be billed at the long-context rate.
 */
import type { RunUsageDelta } from "@yielded/agent/run-options"
import { InputTokenUsage, ModelCallUsage, OutputTokenUsage } from "@yielded/agent/usage"
import { Effect } from "effect"
import { Response } from "effect/ai"
import { assert, describe, it } from "vitest"
import { autumnModelId } from "../platform/ai-credits"
import { accumulateUsage, makeRunUsage, type RunUsage } from "./tools"

const GLM = "z-ai/glm-5.3-flash:nitro"
const SONNET = "anthropic/claude-sonnet-5.5"

interface Call {
	readonly model: string
	readonly uncached: number
	readonly cacheRead?: number
	readonly text: number
	readonly reasoning?: number
}

const consume = (usage: RunUsage, call: Call) => {
	const cacheRead = call.cacheRead ?? 0
	const reasoning = call.reasoning ?? 0
	const input = call.uncached + cacheRead
	const output = call.text + reasoning
	const delta: RunUsageDelta = {
		modelCalls: 1,
		inputTokens: input,
		outputTokens: output,
		totalTokens: input + output,
		toolCalls: 0,
		costMicrousd: 0,
		usage: new Response.Usage({
			inputTokens: { uncached: call.uncached, total: input, cacheRead },
			outputTokens: { total: output, text: call.text, reasoning },
		}),
		modelUsage: new ModelCallUsage({
			provider: "openrouter",
			model: call.model,
			inputTokens: new InputTokenUsage({
				total: input,
				uncached: call.uncached,
				cacheRead,
				cacheWrite: 0,
			}),
			outputTokens: new OutputTokenUsage({ total: output, text: call.text, reasoning }),
			costMicrousd: 0,
		}),
	}
	return Effect.runPromise(accumulateUsage(usage).consume(delta))
}

describe("autumnModelId", () => {
	it("names an OpenRouter model under `openrouter/`, without its routing variant", () => {
		assert.strictEqual(autumnModelId(GLM), "openrouter/z-ai/glm-5.3-flash")
		assert.strictEqual(autumnModelId(SONNET), "openrouter/anthropic/claude-sonnet-5.5")
	})

	it("names a Workers AI model under models.dev's Cloudflare provider, `@cf/` kept", () => {
		assert.strictEqual(
			autumnModelId("@cf/moonshotai/kimi-k2.6"),
			"cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
		)
	})
})

describe("AI credit charges", () => {
	it("splits a call into Autumn's exclusive pools", async () => {
		const usage = makeRunUsage()
		await consume(usage, { model: GLM, uncached: 1000, cacheRead: 4000, text: 200, reasoning: 50 })

		assert.deepEqual(usage.charges, [
			{
				modelId: "openrouter/z-ai/glm-5.3-flash",
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 4000,
				cacheWriteTokens: 0,
				reasoningTokens: 50,
			},
		])
		// The raw totals the diagnosis and legacy meter read are unchanged.
		assert.strictEqual(usage.input, 5000)
		assert.strictEqual(usage.output, 250)
	})

	it("merges small calls to one model into one charge", async () => {
		const usage = makeRunUsage()
		await consume(usage, { model: GLM, uncached: 3000, text: 100 })
		await consume(usage, { model: GLM, uncached: 4000, text: 200 })

		assert.strictEqual(usage.charges.length, 1)
		assert.strictEqual(usage.charges[0]?.inputTokens, 7000)
		assert.strictEqual(usage.charges[0]?.outputTokens, 300)
	})

	it("starts a new charge before a merge would cross a long-context tier", async () => {
		// Two 20k-token calls each bill at the base rate; summed to 40k they would cross a 32k tier.
		const usage = makeRunUsage()
		await consume(usage, { model: GLM, uncached: 5000, cacheRead: 15_000, text: 100 })
		await consume(usage, { model: GLM, uncached: 5000, cacheRead: 15_000, text: 100 })

		assert.deepEqual(
			usage.charges.map((charge) => charge.cacheReadTokens),
			[15_000, 15_000],
		)
	})

	it("keeps each model's calls in a charge of its own", async () => {
		const usage = makeRunUsage()
		await consume(usage, { model: GLM, uncached: 1000, text: 100 })
		await consume(usage, { model: SONNET, uncached: 1000, text: 100 })
		await consume(usage, { model: GLM, uncached: 1000, text: 100 })

		assert.deepEqual(
			usage.charges.map((charge) => charge.modelId),
			[
				"openrouter/z-ai/glm-5.3-flash",
				"openrouter/anthropic/claude-sonnet-5.5",
				"openrouter/z-ai/glm-5.3-flash",
			],
		)
	})
})
