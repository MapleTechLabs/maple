import { testTools } from "../../test/tools"
import { ChatMode, makeChatSessionId } from "@maple/domain/chat-session"
import { evaluatePermission } from "@maple/domain/permission"
import { assert, describe, it } from "vitest"
import { exploreAgent } from "../assistant/agents"
import { hypothesisAgent, plannerAgent, validatorAgent } from "../investigations/agents"
import { buildSystemPrompt, delegationToolName, spawnableFor } from "../runtime/agent"
const mapleToolCatalog = testTools
const MUTATING_TOOL_NAMES = new Set(testTools.filter((t) => t.mutating).map((t) => t.name))
import { investigationIdForSession } from "@maple/domain/ai-investigation-context"
import { agentForSession as resolveAgent } from "./session-agent"
const agentForSession = (id: string) => resolveAgent(id, testTools)

const sessionFor = (mode: ChatMode) =>
	makeChatSessionId("org_test", mode === "investigate" ? "inv-123" : `${mode}-123`)

describe("session agent compatibility", () => {
	it("resolves every existing wire mode to a primary agent", () => {
		for (const mode of ChatMode.literals) {
			assert.equal(agentForSession(sessionFor(mode)).mode, "primary")
		}
	})

	it("uses one assistant for general, alert, widget and old dashboard conversations", () => {
		const general = agentForSession(makeChatSessionId("org_test", "tab"))
		for (const tab of ["alert-123", "widget-fix-123", "dashboard-builder-123"]) {
			const contextual = agentForSession(makeChatSessionId("org_test", tab))
			assert.equal(contextual.name, "assistant")
			assert.equal(contextual.prompt, general.prompt)
			assert.deepEqual(contextual.permission, general.permission)
		}
	})

	it("preserves the report-producing investigation prompt", () => {
		const agent = agentForSession(sessionFor("investigate"))
		assert.equal(agent.name, "investigate")
		assert.include(agent.prompt, "submit_diagnosis")
	})

	it("preserves delegation per task and advertises exactly the offered research role", () => {
		for (const mode of ChatMode.literals) {
			const agent = agentForSession(sessionFor(mode))
			const prompt = buildSystemPrompt(agent)
			if (mode === "default" || mode === "investigate") {
				assert.deepEqual(spawnableFor(agent), [exploreAgent(testTools)])
				assert.include(prompt, delegationToolName("explore"))
			} else {
				assert.isEmpty(spawnableFor(agent))
				assert.notInclude(prompt, "## Delegating")
			}
		}
	})

	it("keeps all headless roles read-only and unable to delegate", () => {
		const hypothesis = hypothesisAgent({
			id: "deploy",
			name: "Deploy",
			question: "Did a deploy cause this?",
			claimToTest: "The deploy changed latency",
			rationale: "Timing matches",
			toolNames: ["list_services"],
		})
		for (const agent of [exploreAgent(testTools), plannerAgent(), hypothesis, validatorAgent]) {
			assert.isEmpty(spawnableFor(agent))
			assert.notInclude(buildSystemPrompt(agent), "## Delegating")
			for (const tool of mapleToolCatalog) {
				assert.notEqual(evaluatePermission(agent.permission, tool.name), "ask")
				if (MUTATING_TOOL_NAMES.has(tool.name)) {
					assert.equal(evaluatePermission(agent.permission, tool.name), "deny")
				}
			}
		}
	})
})

describe("investigation session context", () => {
	it("requires a valid investigation ID before submitting reports or billing as triage", () => {
		for (const tab of ["tab", "inv-", "inv-not-a-uuid"]) {
			assert.isUndefined(investigationIdForSession(makeChatSessionId("org_test", tab)))
		}
		const id = "00000000-0000-0000-0000-000000000000"
		assert.equal(investigationIdForSession(makeChatSessionId("org_test", `inv-${id}`)), id)
	})
})
