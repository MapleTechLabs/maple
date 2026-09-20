/**
 * The agent registry's invariants: a mode with no agent is a runtime `undefined` in the middle of
 * a turn, which is cheap to assert here and expensive to debug live.
 */
import { botSessionId, ChatMode, makeChatSessionId } from "@maple/domain/chat-session"
import { evaluatePermission } from "@maple/domain/permission"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { AGENTS, agentForSession, buildSystemPrompt } from "./agents"
import { rulesetForTurn } from "./permissions"
import { buildChatToolkit } from "./tools"

describe("AGENTS", () => {
	it("names an agent for every wire mode", () => {
		// `chatModeFromSessionId` is on the wire and the client derives from it, so a mode without a
		// matching agent is a runtime `undefined` in the middle of a turn.
		for (const mode of ChatMode.literals) {
			const agent = AGENTS[mode]
			assert.isDefined(agent, `no agent for mode ${mode}`)
			assert.equal(agent?.name, mode)
		}
	})
})

describe("agentForSession", () => {
	it("maps a session id to its mode's agent", () => {
		assert.equal(agentForSession(makeChatSessionId("org_1", "tab")).name, "default")
		assert.equal(agentForSession(makeChatSessionId("org_1", "alert-123")).name, "alert")
		assert.equal(agentForSession(makeChatSessionId("org_1", "inv-abc")).name, "investigate")
		assert.equal(agentForSession(botSessionId("org_1", "discord", "994")).name, "bot")
	})
})

/**
 * The bot answers in a channel anyone can post in, under an org-level actor, with no way to render
 * an approval card. So its mutations are denied rather than gated: the model is never offered one,
 * and there is no proposal for a person who cannot approve it to see.
 */
describe("the bot agent", () => {
	const tenant: TenantContext = {
		orgId: Schema.decodeSync(OrgId)("org_test"),
		userId: Schema.decodeSync(UserId)("chat-bot"),
		roles: [],
		authMode: "self_hosted",
	}
	const executor: McpToolExecutorApi = {
		execute: (_tenant, name) => Effect.succeed({ content: [{ type: "text" as const, text: name }] }),
	}
	const ruleset = rulesetForTurn(AGENTS.bot!, false)

	it("is offered no mutating tool at all", () => {
		const { toolkit } = buildChatToolkit(executor, tenant, ruleset)
		for (const name of MUTATING_TOOL_NAMES) {
			assert.notProperty(toolkit.tools, name, `${name} was offered to the bot`)
		}
	})

	it("proposes nothing, because nobody on this surface can approve", () => {
		// `ask` is the whole of a proposal — it is what `run.ts`'s `isProposed` reads — and a
		// proposal nobody can apply is a promise the surface cannot keep.
		for (const definition of mapleToolCatalog) {
			assert.notEqual(evaluatePermission(ruleset, definition.name), "ask", definition.name)
		}
	})

	it("keeps every read-only tool", () => {
		const { toolkit } = buildChatToolkit(executor, tenant, ruleset)
		for (const name of ["find_errors", "search_traces", "list_services", "query_data"]) {
			assert.property(toolkit.tools, name)
		}
	})
})

describe("buildSystemPrompt", () => {
	it("is the agent's own persona, with no delegation guidance", () => {
		for (const agent of Object.values(AGENTS)) {
			assert.equal(buildSystemPrompt(agent), agent.prompt)
			assert.notInclude(buildSystemPrompt(agent), "## Delegating")
		}
	})
})
