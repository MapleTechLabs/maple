import { useCallback, useMemo, useRef } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useFlueAgent, type AgentStatus, type UIMessage } from "@flue/react"
import { createFlueClient } from "@flue/sdk"
import { flueChatUrl } from "@/lib/services/common/chat-agent-url"

/**
 * Adapter that exposes the Flue chat agent (apps/chat-flue) through the same
 * surface the chat UI already consumes from `@cloudflare/ai-chat`'s
 * `useAgentChat` — so `chat-conversation.tsx` can swap to it with minimal change
 * at cutover.
 *
 * `@flue/react`'s message shape mirrors AI SDK v5 `UIMessage` (text + reasoning +
 * `dynamic-tool` parts with `input-available`/`output-available`/`output-error`
 * states), which the existing renderer already handles.
 *
 * Differences from the legacy hook, handled here:
 *  - status: Flue's `idle`/`connecting` collapse to AI-SDK `ready`.
 *  - approval: Flue has no interrupt-approval. Mutating tools return a
 *    `{status:"proposed"}` result (apps/chat-flue `applyApprovalGates`); the UI
 *    detects proposals from tool output and applies via Maple's API. The
 *    `addToolApprovalResponse` shim is a no-op kept for surface compatibility.
 *  - context: Flue `sendMessage` takes only text, so per-conversation context
 *    (alert / widget-fix / page) rides as a preamble on the first message.
 */

const FLUE_AGENT_NAME = "maple-chat"

/** AI-SDK-style status the chat UI's `PromptInputSubmit` expects. */
export type ChatStatus = "ready" | "submitted" | "streaming" | "error"

const mapStatus = (status: AgentStatus): ChatStatus => {
	switch (status) {
		case "submitted":
			return "submitted"
		case "streaming":
			return "streaming"
		case "error":
			return "error"
		default:
			// idle | connecting
			return "ready"
	}
}

export interface UseFlueChatOptions {
	/** Org-scoped tab id; the agent instance is addressed as `"<orgId>:<tabId>"`. */
	tabId: string
	/** Full transcript vs. the latest N events. Defaults to 100. */
	history?: number | "all"
	/** Prepended to the first user message — the mode/context preamble. */
	firstMessagePreamble?: string
}

export interface UseFlueChatResult {
	messages: UIMessage[]
	status: ChatStatus
	error: Error | undefined
	sendMessage: (input: { text: string }) => Promise<void>
	/** Compatibility shim — Flue uses propose-then-apply, not interrupt-approval. */
	addToolApprovalResponse: (response: { id: string; approved: boolean }) => void
}

export function useFlueChat({
	tabId,
	history = 100,
	firstMessagePreamble,
}: UseFlueChatOptions): UseFlueChatResult {
	const { orgId, getToken } = useAuth()

	const client = useMemo(
		() =>
			createFlueClient({
				baseUrl: flueChatUrl,
				headers: async (): Promise<Record<string, string>> => {
					const token = await getToken()
					return token ? { Authorization: `Bearer ${token}` } : {}
				},
			}),
		[getToken],
	)

	// Undefined id leaves the hook dormant until the org resolves.
	const id = orgId ? `${orgId}:${tabId}` : undefined
	const agent = useFlueAgent({ name: FLUE_AGENT_NAME, id, history, client })

	const preambleSentRef = useRef(false)
	const messageCount = agent.messages.length

	const sendMessage = useCallback(
		async ({ text }: { text: string }) => {
			const withPreamble =
				firstMessagePreamble && !preambleSentRef.current && messageCount === 0
					? `${firstMessagePreamble}\n\n${text}`
					: text
			preambleSentRef.current = true
			await agent.sendMessage(withPreamble)
		},
		[agent, firstMessagePreamble, messageCount],
	)

	return {
		messages: agent.messages,
		status: mapStatus(agent.status),
		error: agent.error,
		sendMessage,
		addToolApprovalResponse: () => {
			// Intentionally a no-op — see the module doc comment (propose-then-apply).
		},
	}
}
