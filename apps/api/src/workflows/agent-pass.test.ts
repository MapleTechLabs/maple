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
import { Effect, Layer, Option, Schema } from "effect"
import { Model } from "effect/unstable/ai"
import { ScriptedModel } from "@effect-agent/testing/ScriptedModel"
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
const turn = (...parts: ReadonlyArray<unknown>) => {
	const flat = parts.flat()
	const calls = flat.some((part) => (part as { type?: string }).type === "tool-call")
	return {
		_tag: "Stream" as const,
		parts: [
			...flat,
			{
				type: "finish" as const,
				reason: calls ? ("tool-calls" as const) : ("stop" as const),
				usage: USAGE,
			},
		],
		termination: { _tag: "Complete" as const },
	}
}

/**
 * A model that answers from a script, and a `ResolvedModel` wrapping it.
 *
 * The pass resolves its model through `provide`, so a scripted one substitutes cleanly without the
 * pass knowing it is under test.
 */
const scripted = (turns: ReadonlyArray<unknown>): ResolvedModel => ({
	provider: "openrouter",
	name: "scripted/test-model",
	limits: { context: 128_000, output: 8_000 },
	// `Model.make` supplies the provider and model identity services alongside the language model;
	// the scripted layer alone provides only the model itself.
	provide: (effect) =>
		Effect.provide(effect, Model.make("scripted", "test-model", ScriptedModel.layer(turns as never))),
})

const run = (turns: ReadonlyArray<unknown>, deadlineAtMs?: number) =>
	runAgentPass({
		id: "pass-1",
		agent: AGENT,
		tenant: TENANT,
		model: scripted(turns),
		prompt: "Is the pool exhausted?",
		submitToolName: "submit_candidate",
		submitToolDescription: "File the candidate.",
		schema: SCHEMA,
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
			// The engine's wall clock is a hard rail, so an out-of-time pass fails rather than
			// getting a last word. What must survive is the answer it already filed.
			const result = yield* run(
				[turn(call("c1", "submit_candidate", { claim: "filed in time" })), turn(text("…"))],
				Date.now() - 1,
			)

			assert.deepEqual(Option.getOrNull(result.answer), { claim: "filed in time" })
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
