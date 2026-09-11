/**
 * A headless pass must always be able to report what it found.
 *
 * This is the regression file for the defect that made investigations look lazy: a pass whose
 * answer *is* a tool call could not answer once it hit its step cap, so `runAgentPass` returned
 * `None`, the workflow recorded a `no_finding` lane, and an agent that had investigated for its
 * entire budget was indistinguishable from one that never looked.
 *
 * Two of the three cases are unchanged. The deadline case changed shape with the engine: wall clock
 * is a hard rail there, so a pass that runs out of time *fails* rather than getting a last word —
 * which is exactly why the answer is recorded by the submit handler as it arrives instead of being
 * read off a successful result.
 */
import { describe, it } from "@effect/vitest"
import { assert } from "vitest"
import { Effect, Layer, Option, Schema, Tracer } from "effect"
import { Model, Tool, Toolkit } from "effect/unstable/ai"
import { MapleToolFailure } from "@/mcp/tools/llm-tools"
import {
	ScriptedModel,
	type ScriptedStreamPart,
	type ScriptedTurnInput,
} from "@effect-agent/testing/ScriptedModel"
import { IdGenerator } from "@effect-agent/core/IdGenerator"
import { PermissionRule } from "@maple/domain/permission"
import { OrgId, UserId } from "@maple/domain"
import type { AgentDefinition } from "@/chat/agents"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { ResolvedModel } from "@/platform/Llm"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

/** A lane agent: three steps, read-only, and no ability to spawn anything. */
const AGENT: AgentDefinition = {
	name: "hypothesis-test",
	description: "test lane",
	mode: "subagent",
	prompt: "Test the hypothesis.",
	permission: [
		new PermissionRule({ tool: "*", action: "deny" }),
		new PermissionRule({ tool: "query_data", action: "allow" }),
	],
	steps: 3,
}

const SCHEMA = Schema.Struct({ claim: Schema.String })

const submitToolkit = Toolkit.make(
	Tool.make("submit_candidate", {
		description: "File the candidate.",
		parameters: SCHEMA,
		success: Schema.String,
		failure: MapleToolFailure,
	}),
)

/** The tool this pass answers through, shaped like the real ones in `./submit-tools.ts`. */
const SUBMIT = {
	name: "submit_candidate",
	schema: SCHEMA,
	toolkit: submitToolkit,
	layer: submitToolkit.toLayer({ submit_candidate: () => Effect.succeed("Recorded.") }),
} as const

const ToolExecutorStubLayer = Layer.succeed(McpToolExecutor, {
	execute: (_tenant, name) =>
		Effect.succeed({ content: [{ type: "text" as const, text: `${name} completed` }] }),
})

/** A spoken part: the engine rejects a delta whose text part was never opened. */
const text = (delta: string) => [
	{ type: "text-start" as const, id: "t1" },
	{ type: "text-delta" as const, id: "t1", delta },
	{ type: "text-end" as const, id: "t1" },
]

const call = (id: string, name: string, params: unknown = {}) => ({
	type: "tool-call" as const,
	id,
	name,
	params,
	providerExecuted: false,
})

/** Token counts the engine's usage accounting needs; the values do not matter to these assertions. */
const USAGE = {
	inputTokens: { uncached: undefined, total: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

/** A scripted turn always ends in a finish part; without one the run fails as a protocol error. */
/**
 * A scripted turn always ends in a finish part, and its reason has to agree with what it emitted:
 * a turn that declared tool calls and reported `stop` is rejected as a protocol error.
 */
const turn = (
	...parts: ReadonlyArray<ScriptedStreamPart | ReadonlyArray<ScriptedStreamPart>>
): ScriptedTurnInput => {
	const flat = parts.flat()
	const calls = flat.some((part) => part.type === "tool-call")
	return {
		_tag: "Stream",
		parts: [
			...flat,
			{
				type: "finish",
				reason: calls ? "tool-calls" : "stop",
				usage: USAGE,
			},
		],
		termination: { _tag: "Complete" },
	}
}

/**
 * A model that answers from a script, and a `ResolvedModel` wrapping it.
 *
 * The pass binds its model to the agent definition, so a scripted one substitutes cleanly without
 * the pass knowing it is under test.
 */
const scripted = (turns: ReadonlyArray<ScriptedTurnInput>): ResolvedModel => ({
	provider: "openrouter",
	name: "scripted/test-model",
	limits: { context: 128_000, output: 8_000 },
	// `Model.make` supplies the provider and model identity services alongside the language model;
	// the scripted layer alone provides only the model itself.
	layer: Model.make("scripted", "test-model", ScriptedModel.layer(turns)),
})

const run = (turns: ReadonlyArray<ScriptedTurnInput>, deadlineAtMs?: number) =>
	runAgentPass({
		id: "pass-1",
		agent: AGENT,
		tenant: TENANT,
		model: scripted(turns),
		prompt: "Is the pool exhausted?",
		submit: SUBMIT,
		...(deadlineAtMs === undefined ? undefined : { deadlineAtMs }),
	}).pipe(Effect.provide(Layer.merge(ToolExecutorStubLayer, IdGenerator.layer)))

describe("runAgentPass", () => {
	it.effect("reports the answer when the agent submits", () =>
		Effect.gen(function* () {
			const result = yield* run([turn(call("c1", "submit_candidate", { claim: "pool exhausted" }))])

			assert.deepEqual(Option.getOrNull(result.answer), { claim: "pool exhausted" })
			// The submit call is the answer, not a tool the lane used to find it.
			assert.equal(result.toolCalls, 0)
		}),
	)

	it.effect("counts the tools the lane used, excluding its own submit call", () =>
		Effect.gen(function* () {
			const result = yield* run([
				turn(call("c1", "query_data", { sql: "select 1" })),
				turn(call("c2", "submit_candidate", { claim: "found it" })),
			])

			assert.equal(result.toolCalls, 1)
			assert.isTrue(Option.isSome(result.answer))
		}),
	)

	it.effect("still submits after spending every step it had", () =>
		Effect.gen(function* () {
			// Three steps of tool calls, then the grace turn the exhaustion policy allows. Without
			// that turn the lane would be recorded as having found nothing at all.
			const result = yield* run([
				turn(call("c1", "query_data")),
				turn(call("c2", "query_data")),
				turn(call("c3", "query_data")),
				turn(call("c4", "submit_candidate", { claim: "late but real" })),
			])

			assert.deepEqual(Option.getOrNull(result.answer), { claim: "late but real" })
		}),
	)

	it.effect("reports what it submitted even when the run then fails", () =>
		Effect.gen(function* () {
			// A required completion tool has to be the sole call in its batch, so this run fails on
			// the very turn that filed the answer. What must survive is the answer.
			const result = yield* run([
				turn(call("s1", "submit_candidate", { claim: "filed in time" }), call("c1", "query_data")),
			])

			assert.deepEqual(Option.getOrNull(result.answer), { claim: "filed in time" })
			// It failed, but not on the clock — and the row must not say it was cut short.
			assert.isFalse(result.deadlineHit)
		}),
	)

	it.live("records a pass that ran out of clock as one", () =>
		Effect.gen(function* () {
			// The one case `deadlineHit` exists for, and the reason it is read off the engine's typed
			// policy failure rather than off a clock comparison afterwards: the validator ranks a lane
			// that was cut short differently from one that simply reported nothing.
			const stalling: ScriptedTurnInput = {
				...turn(text("thinking…")),
				onStreamStart: Effect.sleep("3 seconds"),
			}
			const result = yield* run([stalling], Date.now())

			assert.isTrue(result.deadlineHit)
			assert.isTrue(Option.isNone(result.answer))
		}),
	)

	it.effect("describes the agent on its pass span and each tool call on its own span", () =>
		Effect.gen(function* () {
			const spans: Array<Tracer.NativeSpan> = []
			const tracer = Tracer.make({
				span: (options) => {
					const span = new Tracer.NativeSpan(options)
					spans.push(span)
					return span
				},
			})

			yield* run([
				turn(call("c1", "query_data", { sql: "select 1" })),
				turn(call("c2", "submit_candidate", { claim: "found it" })),
			]).pipe(Effect.withSpan("investigation.test"), Effect.withTracer(tracer))

			const pass = spans.find((span) => span.name === "investigation.test")?.attributes
			assert.strictEqual(pass?.get("gen_ai.operation.name"), "invoke_agent")
			assert.strictEqual(pass?.get("gen_ai.agent.name"), "hypothesis-test")
			assert.strictEqual(pass?.get("gen_ai.agent.description"), "test lane")
			assert.strictEqual(pass?.get("gen_ai.conversation.id"), "pass-1")
			assert.strictEqual(pass?.get("gen_ai.provider.name"), "openrouter")
			assert.strictEqual(pass?.get("gen_ai.request.model"), "scripted/test-model")
			const definitions = JSON.parse(String(pass?.get("gen_ai.tool.definitions")))
			assert.includeMembers(
				definitions.map((tool: { readonly name: string }) => tool.name),
				["query_data", "submit_candidate"],
			)

			const tool = spans.find((span) => span.name === "execute_tool query_data")?.attributes
			assert.deepStrictEqual(JSON.parse(String(tool?.get("gen_ai.tool.call.arguments"))), {
				sql: "select 1",
			})
			assert.deepStrictEqual(JSON.parse(String(tool?.get("gen_ai.tool.call.result"))), {
				result: "query_data completed",
			})
			assert.isNotEmpty(tool?.get("gen_ai.tool.description"))
		}),
	)

	it.effect("reports genuine silence as silence", () =>
		Effect.gen(function* () {
			// "This lens found nothing" is a result the boards render, not an error to propagate.
			const result = yield* run([turn(text("I could not find anything conclusive."))])

			assert.isTrue(Option.isNone(result.answer))
		}),
	)
})
