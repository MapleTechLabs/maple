import type { AiToolDescriptor } from "@maple/domain/ai-service"
import { chatModeFromSessionId, type ChatMode } from "@maple/domain/chat-session"
import { assistantForTask, exploreAgent } from "../assistant/agents"
import { investigationAgent } from "../investigations/agents"
import type { AgentDefinition } from "../runtime/agent"

/**
 * Existing session prefixes remain transport addresses, not agent identities.
 * Keep their interpretation here so feature definitions never parse a session ID.
 */
const sessionAgents = (tools: ReadonlyArray<AiToolDescriptor>) =>
	({
		default: assistantForTask("question", tools),
		alert: assistantForTask("alert", tools),
		"widget-fix": assistantForTask("widget-fix", tools),
		investigate: { ...investigationAgent(tools), spawns: [exploreAgent(tools)] },
	}) satisfies Record<ChatMode, AgentDefinition>

export const agentForSession = (sessionId: string, tools: ReadonlyArray<AiToolDescriptor>): AgentDefinition =>
	sessionAgents(tools)[chatModeFromSessionId(sessionId)]
