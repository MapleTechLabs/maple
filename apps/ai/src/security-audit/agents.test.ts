import { describe, expect, it } from "vitest"
import type { AuditRole } from "@maple/security-audit"
import { layerLlm, resolveSecurityAuditModel, type ResolvedModel } from "../platform/Llm"
import { EXECUTOR_INACTIVITY_TIMEOUT_MS } from "@maple/domain/executor"
import { AGENT_MAX_DURATION, makeAuditAgents, modelFor } from "./agents"
import type { SourceReaderApi } from "./source"
import { AGENT_STEP } from "./workflow.run"
import { Array as Arr, Duration, Effect, Exit, Layer, Record as Rec, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import * as AiModel from "effect/ai/Model"

const models = {
	discovery: resolveSecurityAuditModel({}, "discovery"),
	validation: resolveSecurityAuditModel({}, "validation"),
}

describe("modelFor", () => {
	it("runs both verifiers on the validation model and every other role on discovery", () => {
		const roles: ReadonlyArray<AuditRole> = [
			"recon",
			"synthesis",
			"hunter",
			"critic",
			"candidate-verifier",
			"record-verifier",
		]
		expect(Rec.fromEntries(Arr.map(roles, (role) => [role, modelFor(role, models).name]))).toEqual({
			recon: models.discovery.name,
			synthesis: models.discovery.name,
			hunter: models.discovery.name,
			critic: models.discovery.name,
			"candidate-verifier": models.validation.name,
			"record-verifier": models.validation.name,
		})
	})
})

describe("agent time limits", () => {
	const rail = Duration.toMillis(AGENT_MAX_DURATION)

	/** A step that times out first kills an agent still inside its own rail, with no answer. */
	it("lets every agent reach its rail inside its workflow step", () => {
		expect(rail + 5 * 60 * 1000).toBeLessThanOrEqual(Duration.toMillis(AGENT_STEP.timeout))
	})

	/** Recon and synthesis send the executor nothing: parallel recon, then up to two syntheses. */
	it("keeps the executor alive through recon and synthesis at the rail", () => {
		expect(3 * rail).toBeLessThan(EXECUTOR_INACTIVITY_TIMEOUT_MS)
	})
})

const USAGE = { inputTokens: { total: 1, uncached: 1 }, outputTokens: { total: 1, text: 1 } }

/** A model that answers every call with `parts`, counting the calls it got. */
const scriptedModel = (name: string, parts: ReadonlyArray<Response.StreamPartEncoded>) => {
	const calls = { count: 0 }
	const model: ResolvedModel = {
		provider: "openrouter",
		name,
		limits: { context: 100_000, output: 4_000 },
		layer: AiModel.make(
			"openrouter",
			name,
			Layer.effect(
				LanguageModel.LanguageModel,
				LanguageModel.make({
					generateText: () => Effect.die("audit agents stream; generateText is never called"),
					streamText: () =>
						Stream.suspend(() => {
							calls.count++
							return Stream.fromIterable(parts)
						}),
				}),
			),
		),
	}
	return { model, calls }
}

const answering = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "text-start", id: "t" },
	{ type: "text-delta", id: "t", delta: text },
	{ type: "text-end", id: "t" },
	{ type: "finish", reason: "stop", usage: USAGE },
]

/** What OpenAI's cybersecurity filter sends back for a hunter prompt (run a64e92e2, 2026-11-11). */
const refusing: ReadonlyArray<Response.StreamPartEncoded> = [
	{ type: "error", error: "This content was flagged for possible cybersecurity risk." },
]

const noSource: SourceReaderApi = {
	readFile: () => Effect.succeed({ text: "", truncated: false }),
	grep: () => Effect.succeed({ text: "", truncated: false }),
	listFiles: () => Effect.succeed({ text: "", truncated: false }),
	log: () => Effect.succeed({ text: "", truncated: false }),
	nearby: () => Effect.succeed({ text: "", truncated: false }),
}

const runAgent = (models: Parameters<typeof makeAuditAgents>[0], role: AuditRole) =>
	Effect.runPromiseExit(
		makeAuditAgents(models, noSource).pipe(
			Effect.flatMap((agents) => agents.run({ role, agentId: `${role}-1`, prompt: "audit" })),
			Effect.provide(layerLlm({})),
		),
	)

describe("discovery fallback", () => {
	it("reruns a hunter the org's model refused on the fallback model", async () => {
		const chosen = scriptedModel("openai/gpt-6.1-sol", refusing)
		const fallback = scriptedModel("anthropic/claude-haiku-5.5", answering("no findings"))
		const verifier = scriptedModel("anthropic/claude-sonnet-5.5", answering("unused"))

		const exit = await runAgent(
			{ discovery: chosen.model, validation: verifier.model, discoveryFallback: fallback.model },
			"hunter",
		)

		expect(Exit.isSuccess(exit) && exit.value.text).toBe("no findings")
		expect(fallback.calls.count).toBe(1)
	})

	it("never moves a verifier onto the hunting fallback", async () => {
		const hunter = scriptedModel("anthropic/claude-haiku-5.5", answering("unused"))
		const verifier = scriptedModel("openai/gpt-6-luna", refusing)

		const exit = await runAgent(
			{ discovery: hunter.model, validation: verifier.model, discoveryFallback: hunter.model },
			"record-verifier",
		)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(hunter.calls.count).toBe(0)
	})
})
