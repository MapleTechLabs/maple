/**
 * The agent registry's invariants: a mode with no agent is a runtime `undefined` in the middle of
 * a turn, which is cheap to assert here and expensive to debug live.
 */
import { ChatMode, makeChatSessionId } from "@maple/domain/chat-session"
import { assert, describe, it } from "vitest"
import { AGENTS, agentForSession, buildSystemPrompt } from "./agents"

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
