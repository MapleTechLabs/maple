/**
 * The agent registry's invariants: a mode with no agent is a runtime `undefined` in the middle of
 * a turn, which is cheap to assert here and expensive to debug live.
 */
import {
	type ChatTurnOrigin,
	ChatConnectorId,
	ChatConversationKey,
	ChatMode,
	connectorSessionId,
	makeChatSessionId,
} from "@maple/domain/chat-session"
import { evaluatePermission } from "@maple/domain/permission"
import { ExternalUserId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { AGENTS, agentForSession, buildSystemPrompt } from "./agents"
import { profileForTurn } from "./profiles"
import { CHAT_BUDGET } from "./budgets"
import { CONNECTOR_SYSTEM_PROMPT } from "./prompts"
import { buildChatToolkit } from "./tools"

/** A connector id, not a real one: the engine never learns which chat platform it answers in. */
const CONNECTOR = Schema.decodeSync(ChatConnectorId)("testchat")
const CONVERSATION = Schema.decodeSync(ChatConversationKey)("c1")

const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	kind: "connector",
	connectorId: CONNECTOR,
	workspaceId: "w1",
	externalUserId: Schema.decodeSync(ExternalUserId)("u-1"),
	displayName: "Ada",
}

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
		// A connector thread is an ordinary chat conversation; its ORIGIN is what differs.
		assert.equal(
			agentForSession(connectorSessionId(Schema.decodeSync(OrgId)("org_1"), CONNECTOR, CONVERSATION))
				.name,
			"default",
		)
	})
})

/**
 * What a turn's origin decides, through the toolkit a run actually builds. A connector proposes
 * mutations exactly as the app does, but runs on a surface that is not internal — so the
 * agents-only tools never enter its catalog. Both directions, so neither can pass vacuously.
 */
describe("profileForTurn", () => {
	const orgId = Schema.decodeSync(OrgId)("org_test")
	const connectorSession = connectorSessionId(orgId, CONNECTOR, CONVERSATION)
	const appSession = makeChatSessionId(orgId, "tab")
	const tenant: TenantContext = {
		orgId,
		userId: Schema.decodeSync(UserId)("user_1"),
		roles: [],
		authMode: "self_hosted",
	}
	const executor: McpToolExecutorApi = {
		execute: (_tenant, name) => Effect.succeed({ content: [{ type: "text" as const, text: name }] }),
	}
	/** Exactly what `runChatTurn` builds, through the same policy. */
	const toolsFor = (sessionId: string, origin: ChatTurnOrigin) => {
		const profile = profileForTurn(agentForSession(sessionId), origin)
		return {
			profile,
			tools: buildChatToolkit(executor, tenant, profile.ruleset, profile.surface).toolkit.tools,
		}
	}

	it("offers a connector every mutating tool, and proposes rather than performs each one", () => {
		// `ask` is the whole of a proposal: `run.ts`'s `isProposed` reads it, the dispatched call
		// refuses, and the schema the connector renders for approval is the real one.
		const { profile, tools } = toolsFor(connectorSession, CONNECTOR_ORIGIN)
		for (const name of MUTATING_TOOL_NAMES) {
			assert.property(tools, name, `${name} was withheld from the connector`)
			assert.equal(evaluatePermission(profile.ruleset, name), "ask", name)
		}
	})

	it("offers a connector no internal-audience tool, so a channel cannot reach the sandbox", () => {
		// `sandbox_exec` is code execution against the org's checkout, answering into a thread
		// anyone can read, and nothing proposes it for approval first.
		const { tools } = toolsFor(connectorSession, CONNECTOR_ORIGIN)
		const internal = mapleToolCatalog.filter((definition) => definition.audience === "internal")
		assert.isNotEmpty(internal, "no internal tools in the catalog — this test would pass vacuously")
		for (const definition of internal) {
			assert.notProperty(tools, definition.name, `${definition.name} was offered to the connector`)
		}
	})

	it("keeps the read tools a connector answers with, ungated", () => {
		const { profile, tools } = toolsFor(connectorSession, CONNECTOR_ORIGIN)
		for (const name of ["find_errors", "search_traces", "list_services", "query_data"]) {
			assert.property(tools, name)
			assert.equal(evaluatePermission(profile.ruleset, name), "allow", name)
		}
	})

	it("leaves an app turn its own persona, surface and internal tools", () => {
		const { profile, tools } = toolsFor(appSession, { kind: "app" })
		assert.equal(profile.surface, "chat")
		assert.equal(profile.prompt, AGENTS.default.prompt)
		assert.property(tools, "sandbox_exec")
	})

	it("speaks the connector persona, not the in-app one that teaches a 420px panel", () => {
		assert.equal(
			profileForTurn(agentForSession(connectorSession), CONNECTOR_ORIGIN).prompt,
			CONNECTOR_SYSTEM_PROMPT,
		)
	})

	it("denies the autonomous pass its mutations while leaving it the internal tools", () => {
		// Unchanged: the pass has no reader, so a gated tool is a wasted call.
		const { profile, tools } = toolsFor(makeChatSessionId(orgId, "inv-abc"), { kind: "autonomous" })
		assert.equal(profile.surface, "chat")
		assert.property(tools, "sandbox_exec")
		for (const name of MUTATING_TOOL_NAMES) assert.notProperty(tools, name)
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
