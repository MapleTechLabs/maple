import { afterEach, describe, expect, test } from "bun:test"
import { generateText, type LanguageModel } from "ai"
import { agentModel } from "./agent-model.js"
import { installFetchStub, type FetchStub } from "./fetch-stub.js"

type StepStarted = NonNullable<(typeof agentModel.events)["step.started"]>

let stub: FetchStub | undefined

afterEach(() => {
	stub?.restore()
	stub = undefined
})

/** The JSON body OpenRouter would have received for one call on `model`. */
const capturedBody = async (model: LanguageModel): Promise<Record<string, unknown>> => {
	stub = installFetchStub(
		() => new Response(JSON.stringify({ error: { message: "captured", code: 400 } }), { status: 400 }),
	)
	await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => undefined)
	const body = stub.calls[0]?.body
	if (typeof body !== "string") throw new Error("no request reached the transport")
	return JSON.parse(body) as Record<string, unknown>
}

describe("agentModel", () => {
	test("a step's request carries the eve session it runs in", async () => {
		const ctx = { session: { id: "wrun_01TEST" }, channel: {}, messages: [] } as unknown as Parameters<StepStarted>[1]
		const selection = await agentModel.events["step.started"]!({}, ctx)
		if (selection === null || typeof selection !== "object" || !("modelContextWindowTokens" in selection)) {
			throw new Error("step.started did not return a model selection")
		}
		expect(selection.modelContextWindowTokens).toBeGreaterThan(0)

		const body = await capturedBody(selection.model as LanguageModel)
		expect(body.session_id).toBe("wrun_01TEST")
		expect(body.trace).toEqual({ trace_name: "slack" })
		expect(body.usage).toEqual({ include: true })
	})

	test("the fallback, used before any session exists, carries none", async () => {
		const body = await capturedBody(agentModel.fallback)
		expect(body).not.toHaveProperty("session_id")
		expect(body.usage).toEqual({ include: true })
	})
})
