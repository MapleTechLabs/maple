/**
 * The tools a headless pass answers through, exercised with the real answer schemas.
 *
 * `agent-pass.test.ts` proves the seam with a two-field stand-in. This file is the other half: the
 * four declarations the investigation actually ships, whose parameters are domain `Schema.Class`es
 * an order of magnitude larger. Two things can only break here — a schema Effect AI cannot render
 * as JSON Schema, which no model would ever see a tool for, and a decode of the model's answer
 * through that same schema, which is what makes the submitted parameters the run's output.
 */
import { describe, it } from "@effect/vitest"
import { assert } from "vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Model, Tool } from "effect/unstable/ai"
import {
	ScriptedModel,
	type ScriptedStreamPart,
	type ScriptedTurnInput,
} from "@effect-agent/testing/ScriptedModel"
import { IdGenerator } from "@effect-agent/core/IdGenerator"
import { ValidatorVerdict } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/domain"
import { PermissionRule } from "@maple/domain/permission"
import type { AgentDefinition } from "@/chat/agents"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { ResolvedModel } from "@/platform/Llm"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"
import { submitCandidate, submitDiagnosis, submitPlan, submitVerdict } from "./submit-tools"

const ALL = [submitCandidate, submitDiagnosis, submitPlan, submitVerdict]

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

/** No tools: this pass is about the submit call, not about what it looked at first. */
const AGENT: AgentDefinition = {
	name: "verdict-test",
	description: "test pass",
	mode: "subagent",
	prompt: "Rank the candidates.",
	permission: [new PermissionRule({ tool: "*", action: "deny" })],
	steps: 2,
}

const ToolExecutorStubLayer = Layer.succeed(McpToolExecutor, {
	execute: (_tenant, name) =>
		Effect.succeed({ content: [{ type: "text" as const, text: `${name} completed` }] }),
})

const USAGE = {
	inputTokens: { uncached: undefined, total: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

const text = (delta: string): ReadonlyArray<ScriptedStreamPart> => [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta },
	{ type: "text-end", id: "t1" },
]

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

const submitCall = (params: unknown): ScriptedStreamPart => ({
	type: "tool-call",
	id: "s1",
	name: submitVerdict.name,
	params,
	providerExecuted: false,
})

const scripted = (turns: ReadonlyArray<ScriptedTurnInput>): ResolvedModel => ({
	provider: "openrouter",
	name: "scripted/test-model",
	limits: { context: 128_000, output: 8_000 },
	layer: Model.make("scripted", "test-model", ScriptedModel.layer(turns)),
})

const run = (turns: ReadonlyArray<ScriptedTurnInput>) =>
	runAgentPass({
		id: "verdict-pass",
		agent: AGENT,
		tenant: TENANT,
		model: scripted(turns),
		prompt: "Rank them.",
		submit: submitVerdict,
	}).pipe(Effect.provide(Layer.merge(ToolExecutorStubLayer, IdGenerator.layer)))

/** A verdict that promotes nothing, which is the shape production sees most. */
const VERDICT = {
	promotedLensId: null,
	report: null,
	rivals: [],
	note: "Two lanes reported; neither held up.",
}

describe("the shipped submit tools", () => {
	it("render a JSON Schema for every answer shape", () => {
		// A schema Effect AI cannot render is a tool the model is never shown, which reads in
		// production as a pass that simply never submits.
		for (const submit of ALL) {
			const rendered = JSON.stringify(Tool.getJsonSchemaFromSchema(submit.schema))
			// Rendering at all is most of the assertion; the field names are there so a schema that
			// rendered to an empty object, or to a reference nothing resolves, still fails.
			for (const field of Object.keys(submit.schema.fields)) {
				assert.include(rendered, `"${field}"`, `${submit.name} lost ${field}`)
			}
		}
	})

	it("declare a tool under the name the pass completes on", () => {
		for (const submit of ALL) {
			assert.property(submit.toolkit.tools, submit.name)
		}
	})
})

describe("a pass answering with a real domain schema", () => {
	it.effect("returns the submitted verdict, decoded", () =>
		Effect.gen(function* () {
			const result = yield* run([turn(submitCall(VERDICT))])
			const verdict = Option.getOrNull(result.answer)

			assert.instanceOf(verdict, ValidatorVerdict)
			assert.equal(verdict?.note, VERDICT.note)
			assert.isNull(verdict?.promotedLensId)
			// The submit call is the answer, not a tool the pass used to reach it.
			assert.equal(result.toolCalls, 0)
		}),
	)

	it.effect("rejects an answer that does not match, and reports nothing", () =>
		Effect.gen(function* () {
			// `note` is required. The engine decodes the call against the tool's own schema, so this
			// is refused before any projection and the model is told why — where a JSON-Schema-only
			// tool would have accepted the call and left the decode to us afterwards.
			const result = yield* run([
				turn(submitCall({ promotedLensId: null, report: null, rivals: [] })),
				turn(text("I could not produce a ranking.")),
			])

			assert.isTrue(Option.isNone(result.answer))
		}),
	)
})
