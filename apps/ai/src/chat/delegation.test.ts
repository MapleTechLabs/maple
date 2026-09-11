import { testTools, testClients } from "../../test/tools"
/**
 * The delegation tools have to exist.
 *
 * This file is the regression for the cutover's worst defect: `buildSystemPrompt` promised the
 * model a delegation tool, nothing built one, and a model that took the prompt at its word
 * declared a tool the engine had never been shown — which ends the run as a protocol error, not as
 * a tool failure the model can route around. Every test here compares what the prompt promises
 * against what the turn actually offers.
 */
import { OrgId, UserId } from "@maple/domain"
import { Effect, Schema } from "effect"
import { Model } from "effect/unstable/ai"
import { ScriptedModel } from "@effect-agent/testing/ScriptedModel"
import { assert, describe, it } from "vitest"
import type { ToolExecutorApi } from "../runtime/tool-executor"
import type { ResolvedModel } from "../platform/Llm"
import type { ChatTurnTenant as TenantContext } from "@maple/domain/chat-session"
import { makeChatSessionId } from "@maple/domain/chat-session"
import type { ScriptedStreamPart, ScriptedTurnInput } from "@effect-agent/testing/ScriptedModel"
import { buildSystemPrompt, delegationToolName, spawnableFor } from "../runtime/agent"
import { ChatMode } from "@maple/domain/chat-session"
import { agentForSession as resolveAgent } from "./session-agent"
const agentForSession = (id: string) => resolveAgent(id, testTools)
import { buildDelegation } from "../runtime/delegation"
import { runChatTurn } from "./run"
import { makeRunUsage } from "../runtime/usage"
import type { ChatTurnEvent } from "./events"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const executor: ToolExecutorApi = {
	tools: testTools,
	execute: (name) => Effect.succeed({ content: [{ type: "text" as const, text: `${name} completed` }] }),
}

/** Never invoked here: building the tools does not run them. */
const MODEL: ResolvedModel = {
	provider: "openrouter",
	name: "scripted/test-model",
	limits: { context: 128_000, output: 8_000 },
	layer: Model.make("scripted", "test-model", ScriptedModel.layer([])),
}

const spawners = ChatMode.literals
	.map((mode) =>
		agentForSession(makeChatSessionId("org_test", mode === "investigate" ? "inv-123" : `${mode}-123`)),
	)
	.filter((agent) => spawnableFor(agent).length > 0)

describe("buildDelegation", () => {
	it("has at least one agent that delegates, or these tests prove nothing", () => {
		assert.isNotEmpty(spawners)
	})

	it("offers a tool for every sub-agent its prompt names", () => {
		for (const agent of spawners) {
			const delegation = buildDelegation(agent, executor, MODEL)
			assert.isDefined(delegation, `${agent.name} spawns but built no delegation`)
			const offered = Object.keys(delegation?.toolkit.tools ?? {})
			const prompt = buildSystemPrompt(agent)

			for (const child of spawnableFor(agent)) {
				const tool = delegationToolName(child.name)
				assert.include(prompt, tool, `${agent.name}'s prompt does not name ${tool}`)
				assert.include(offered, tool, `${agent.name} was never given ${tool}`)
			}
		}
	})

	it("gives an agent that spawns nothing no delegation tool at all", () => {
		// Opt-in per agent: a turn that cannot delegate carries no delegation tool, rather than one
		// that is offered and refuses.
		const agent = agentForSession(makeChatSessionId("org_test", "alert-123"))

		assert.isEmpty(spawnableFor(agent))
		assert.isUndefined(buildDelegation(agent, executor, MODEL))
	})

	it("names delegation tools apart from every Maple tool", async () => {
		const mapleToolCatalog = testTools
		const registry = new Set(mapleToolCatalog.map((definition) => definition.name))

		for (const agent of spawners) {
			for (const child of spawnableFor(agent)) {
				assert.notInclude([...registry], delegationToolName(child.name))
			}
		}
	})
})

/** Token counts the engine's usage accounting needs; the values do not matter to these assertions. */
const USAGE = {
	inputTokens: { uncached: undefined, total: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

const text = (delta: string): ReadonlyArray<ScriptedStreamPart> => [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta },
	{ type: "text-end", id: "t1" },
]

const call = (id: string, name: string, params: unknown): ScriptedStreamPart => ({
	type: "tool-call",
	id,
	name,
	params,
	providerExecuted: false,
})

const turn = (
	...parts: ReadonlyArray<ScriptedStreamPart | ReadonlyArray<ScriptedStreamPart>>
): ScriptedTurnInput => {
	const flat = parts.flat()
	const calls = flat.some((part) => part.type === "tool-call")
	return {
		_tag: "Stream",
		parts: [...flat, { type: "finish", reason: calls ? "tool-calls" : "stop", usage: USAGE }],
		termination: { _tag: "Complete" },
	}
}

const scripted = (turns: ReadonlyArray<ScriptedTurnInput>): ResolvedModel => ({
	...MODEL,
	layer: Model.make("scripted", "test-model", ScriptedModel.layer(turns)),
})

describe("a delegating turn", () => {
	it("runs the sub-agent and hands its answer back to the parent", async () => {
		const events: Array<ChatTurnEvent> = []
		// Two scripts, because the parent and the sub-agent are two runs against two models — which
		// is the point of binding a model to a definition rather than providing one around a turn.
		const model = scripted([
			turn(call("d1", delegationToolName("explore"), { prompt: "which endpoints are slow?" })),
			turn(text("Explore says checkout is the slow one.")),
		])
		const subagentModel = scripted([turn(text("Checkout p99 is 4.2s."))])

		await Effect.runPromise(
			runChatTurn({
				sessionId: makeChatSessionId(TENANT.orgId, "tab"),
				messageId: "a1",
				tenant: TENANT,
				toolExecutor: executor,
				model,
				subagentModel,
				submitDiagnosis: () => Effect.succeed(undefined),
				text: "why is the app slow?",
				history: [],
				usage: makeRunUsage(),
				holdsTurn: () => true,
				append: (batch) =>
					Effect.sync(() => {
						events.push(...batch)
					}),
			}).pipe(Effect.provide(testClients)),
		)

		const declared = events.find((event) => event.type === "tool-call")
		assert.equal(declared?.name, delegationToolName("explore"), "the delegation was never called")

		// The child's run is reported on its own card, keyed by the delegation call.
		const childStart = events
			.filter((event) => event.type === "turn-start")
			.find((event) => event.task !== undefined)
		assert.equal(childStart?.task?.agent, "explore")
		assert.equal(childStart?.task?.id, declared?.callId)

		// The parent's tool result carries the child's answer, and nothing of how it found it.
		const result = events.find((event) => event.type === "tool-result")
		assert.include(JSON.stringify(result?.output), "Checkout p99 is 4.2s.")

		const spoken = events
			.filter((event) => event.type === "text-delta")
			.filter((event) => event.task === undefined)
			.map((event) => event.text)
			.join("")
		assert.include(spoken, "checkout is the slow one")
	})
})
