/**
 * The agent registry's invariants: a mode with no agent is a runtime `undefined` in the middle of
 * a turn, which is cheap to assert here and expensive to debug live.
 */
import {
	botSessionId,
	CHAT_BOT_USER_ID,
	ChatConnectorId,
	ChatMode,
	makeChatSessionId,
} from "@maple/domain/chat-session"
import { evaluatePermission } from "@maple/domain/permission"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { AGENTS, agentForSession, agentForTurn, buildSystemPrompt } from "./agents"
import { CHAT_BUDGET } from "./budgets"
import { turnToolPolicy } from "./run"
import { buildChatToolkit } from "./tools"

/** A connector id, not a real one: the engine never learns which chat platform it answers in. */
const CONNECTOR = Schema.decodeSync(ChatConnectorId)("testchat")

describe("AGENTS", () => {
	it("names an agent for every wire mode", () => {
		// `chatModeFromSessionId` is on the wire and the client derives from it, so a mode without a
		// matching agent is a runtime `undefined` in the middle of a turn.
		// `AGENTS` is keyed by `ChatMode`, so this is now a belt to the compiler's braces: it also
		// pins that the record's key IS the agent's name, which `agentForSession` relies on.
		for (const mode of ChatMode.literals) {
			assert.equal(AGENTS[mode].name, mode)
		}
	})
})

describe("agentForSession", () => {
	it("maps a session id to its mode's agent", () => {
		assert.equal(agentForSession(makeChatSessionId("org_1", "tab")).name, "default")
		assert.equal(agentForSession(makeChatSessionId("org_1", "alert-123")).name, "alert")
		assert.equal(agentForSession(makeChatSessionId("org_1", "inv-abc")).name, "investigate")
		assert.equal(
			agentForSession(botSessionId(Schema.decodeSync(OrgId)("org_1"), CONNECTOR, "994")).name,
			"bot",
		)
	})
})

/**
 * The bot answers in a channel anyone can post in, under an org-level actor. It proposes mutations
 * exactly as in-app chat does — the approval is rendered by the platform connector instead of the
 * Maple UI — but it runs on a surface that is not internal, so the agents-only tools never enter
 * its catalog at all. The tests below are that boundary in both directions.
 */
describe("the bot agent", () => {
	const orgId = Schema.decodeSync(OrgId)("org_test")
	const botSession = botSessionId(orgId, CONNECTOR, "994")
	const tenant = (userId: string): TenantContext => ({
		orgId,
		userId: Schema.decodeSync(UserId)(userId),
		roles: [],
		authMode: "self_hosted",
	})
	const executor: McpToolExecutorApi = {
		execute: (_tenant, name) => Effect.succeed({ content: [{ type: "text" as const, text: name }] }),
	}
	/** Exactly what `runChatTurn` builds, through the same policy. */
	const toolsFor = (sessionId: string, userId: string) => {
		const policy = turnToolPolicy(sessionId, tenant(userId))
		return {
			policy,
			tools: buildChatToolkit(executor, tenant(userId), policy.ruleset, policy.surface).toolkit.tools,
		}
	}

	it("spends an attended turn's budget, not the investigation rail", () => {
		assert.strictEqual(AGENTS.bot.budget, CHAT_BUDGET)
	})

	it("is offered every mutating tool, and proposes rather than performs each one", () => {
		// `ask` is the whole of a proposal — it is what `run.ts`'s `isProposed` reads, and what makes
		// the dispatched call refuse. The tool is still offered with its real schema, so the connector
		// has the arguments to render for approval.
		const { policy, tools } = toolsFor(botSession, CHAT_BOT_USER_ID)
		for (const name of MUTATING_TOOL_NAMES) {
			assert.property(tools, name, `${name} was withheld from the bot`)
			assert.equal(evaluatePermission(policy.ruleset, name), "ask", name)
		}
	})

	it("is offered no internal-audience tool, so a channel cannot reach the repository sandbox", () => {
		// The reply lands wherever the thread is readable. `sandbox_exec` alone is code execution
		// against the org's checkout, and nothing proposes it for approval first — which is why the
		// audience boundary, not the ruleset, is what holds it back.
		const { tools } = toolsFor(botSession, CHAT_BOT_USER_ID)
		const internal = mapleToolCatalog.filter((definition) => definition.audience === "internal")
		assert.isNotEmpty(internal, "no internal tools in the catalog — this test would pass vacuously")
		for (const definition of internal) {
			assert.notProperty(tools, definition.name, `${definition.name} was offered to the bot`)
		}
	})

	it("keeps the read tools it answers with, ungated", () => {
		const { policy, tools } = toolsFor(botSession, CHAT_BOT_USER_ID)
		for (const name of ["find_errors", "search_traces", "list_services", "query_data"]) {
			assert.property(tools, name)
			assert.equal(evaluatePermission(policy.ruleset, name), "allow", name)
		}
	})

	it("runs as the bot when the actor lands on a session that is not a bot one", () => {
		// The session id is built by a Worker outside this app, so the actor is the signal it cannot
		// forge. A mismatch must not hand an org-level actor the internal toolset — and must not
		// hand it the in-app prompt either, which teaches a 420px panel and markdown tables.
		const session = makeChatSessionId(orgId, "tab")
		const { policy, tools } = toolsFor(session, CHAT_BOT_USER_ID)
		assert.equal(policy.surface, "bot")
		assert.equal(agentForTurn(session, CHAT_BOT_USER_ID), AGENTS.bot)
		assert.notProperty(tools, "sandbox_exec")
	})

	it("leaves an ordinary chat turn its own agent and internal tools", () => {
		// The converse, so the guard above cannot pass by treating everyone as the bot.
		const session = makeChatSessionId(orgId, "tab")
		const { policy, tools } = toolsFor(session, "user_1")
		assert.equal(policy.surface, "chat")
		assert.equal(agentForTurn(session, "user_1"), AGENTS.default)
		assert.property(tools, "sandbox_exec")
	})
})

/**
 * The bot prompt's own invariants.
 *
 * That it names no chat platform is not asserted here, because the assertion would have to name
 * them: nothing in this package or the domain knows one exists, so a vendor name in the prompt
 * would have to be typed in by hand against the grain of everything around it.
 */
describe("BOT_SYSTEM_PROMPT", () => {
	it("teaches the approval step, and the prohibition on imitating one in prose", () => {
		// The model's mutations are gated, so it has to be told — and told not to render the gate
		// itself, which the connector does. The prohibition quotes "[Approve]" on purpose.
		assert.include(AGENTS.bot.prompt, "approved before they take effect")
		assert.include(AGENTS.bot.prompt, 'NEVER emit "[Approve]"')
	})

	it("points nobody at the Maple app, because it can act from here", () => {
		// The prompt said the opposite while the bot was read-only; a model still carrying that
		// would refuse the gated tools it is now offered.
		assert.notInclude(AGENTS.bot.prompt, "Maple app")
	})

	it("keeps the renderings the chat connectors depend on", () => {
		assert.include(AGENTS.bot.prompt, "```chart")
		assert.include(AGENTS.bot.prompt, "<<maple:trace:")
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
