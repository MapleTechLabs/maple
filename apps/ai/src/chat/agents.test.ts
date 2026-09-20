/**
 * The agent registry's invariants: a mode with no agent is a runtime `undefined` in the middle of
 * a turn, which is cheap to assert here and expensive to debug live.
 */
import { botSessionId, CHAT_BOT_USER_ID, ChatMode, makeChatSessionId } from "@maple/domain/chat-session"
import { evaluatePermission } from "@maple/domain/permission"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { AGENTS, agentForSession, buildSystemPrompt } from "./agents"
import { CHAT_BUDGET } from "./budgets"
import { turnToolPolicy } from "./run"
import { buildChatToolkit } from "./tools"

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
			agentForSession(botSessionId(Schema.decodeSync(OrgId)("org_1"), "discord", "994")).name,
			"bot",
		)
	})
})

/**
 * The bot answers in a channel anyone can post in, under an org-level actor, with no way to render
 * an approval card. Two things follow, and the tests below are the whole of "the bot is read-only":
 * its mutations are denied rather than gated, and it runs on a surface that is not internal, so the
 * agents-only tools never enter its catalog at all.
 */
describe("the bot agent", () => {
	const orgId = Schema.decodeSync(OrgId)("org_test")
	const botSession = botSessionId(orgId, "discord", "994")
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

	it("is offered no mutating tool at all", () => {
		const { tools } = toolsFor(botSession, CHAT_BOT_USER_ID)
		for (const name of MUTATING_TOOL_NAMES) {
			assert.notProperty(tools, name, `${name} was offered to the bot`)
		}
	})

	it("is offered no internal-audience tool, so a channel cannot reach the repository sandbox", () => {
		// The reply lands wherever the thread is readable. `sandbox_exec` alone is code execution
		// against the org's checkout; the ruleset would have allowed it, and only the surface does not.
		const { tools } = toolsFor(botSession, CHAT_BOT_USER_ID)
		const internal = mapleToolCatalog.filter((definition) => definition.audience === "internal")
		assert.isNotEmpty(internal, "no internal tools in the catalog — this test would pass vacuously")
		for (const definition of internal) {
			assert.notProperty(tools, definition.name, `${definition.name} was offered to the bot`)
		}
	})

	it("proposes nothing, because nobody on this surface can approve", () => {
		// `ask` is the whole of a proposal — it is what `run.ts`'s `isProposed` reads — and a
		// proposal nobody can apply is a promise the surface cannot keep.
		const { policy } = toolsFor(botSession, CHAT_BOT_USER_ID)
		for (const definition of mapleToolCatalog) {
			assert.notEqual(evaluatePermission(policy.ruleset, definition.name), "ask", definition.name)
		}
	})

	it("keeps the read-only tools it answers with", () => {
		const { tools } = toolsFor(botSession, CHAT_BOT_USER_ID)
		for (const name of ["find_errors", "search_traces", "list_services", "query_data"]) {
			assert.property(tools, name)
		}
	})

	it("stays read-only when the actor lands on a session that is not a bot one", () => {
		// The session id is built by a Worker outside this app. A mismatch must not promote an
		// org-level actor to the default agent's gated mutations and internal toolset.
		const { policy, tools } = toolsFor(makeChatSessionId(orgId, "tab"), CHAT_BOT_USER_ID)
		assert.equal(policy.surface, "bot")
		for (const name of MUTATING_TOOL_NAMES) assert.notProperty(tools, name)
		assert.notProperty(tools, "sandbox_exec")
	})

	it("leaves an ordinary chat turn its gated mutations and internal tools", () => {
		// The converse, so the guard above cannot pass by denying everyone.
		const { policy, tools } = toolsFor(makeChatSessionId(orgId, "tab"), "user_1")
		assert.equal(policy.surface, "chat")
		assert.equal(evaluatePermission(policy.ruleset, "create_dashboard"), "ask")
		assert.property(tools, "sandbox_exec")
	})
})

/**
 * The bot prompt's own invariants. Re-adding `APPROVAL_NOTE` is a one-line edit in a file where
 * every other prompt carries it, and it would put approval prose in front of a model that has no
 * gated tool to approve.
 */
describe("BOT_SYSTEM_PROMPT", () => {
	it("teaches no approval step, but keeps the prohibition on imitating one", () => {
		// `APPROVAL_NOTE`'s own words, which would tell this model its mutations are gated when it
		// has none. The prohibition quotes "[Approve]" on purpose and must survive.
		assert.notInclude(AGENTS.bot.prompt, "approval step")
		assert.notInclude(AGENTS.bot.prompt, "approval-gated")
		assert.include(AGENTS.bot.prompt, 'NEVER emit "[Approve]"')
	})

	it("names no chat platform, because the adapters differ and the model must not write for one", () => {
		for (const platform of ["Discord", "Slack", "discord", "slack"]) {
			assert.notInclude(AGENTS.bot.prompt, platform)
		}
	})

	it("keeps the renderings the chat adapters depend on", () => {
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
