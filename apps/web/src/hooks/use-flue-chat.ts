import { useCallback, useMemo } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useFlueAgent, type AgentStatus, type UIMessage } from "@flue/react"
import type { ChatStatus } from "@/components/ai-elements/types"
import {
	buildContextPreamble,
	stripContextPreamble,
	wrapContextPreamble,
	type ChatContext,
} from "@/components/chat/context-preamble"

const AGENT_NAME = "maple-chat"

export interface UseFlueChatOptions {
	tabId: string
	/** Per-conversation context folded into the first message preamble. */
	context?: ChatContext
}

export interface UseFlueChatResult {
	messages: UIMessage[]
	status: ChatStatus
	error: Error | undefined
	isLoading: boolean
	sendMessage: (text: string) => void
}

/** Flue's `idle`/`connecting` have no composer equivalent — treat them as ready. */
const toChatStatus = (status: AgentStatus): ChatStatus => {
	switch (status) {
		case "submitted":
			return "submitted"
		case "streaming":
			return "streaming"
		case "error":
			return "error"
		default:
			return "ready"
	}
}

/** Hide the first-message context block from the user's own bubble. */
const cleanForDisplay = (message: UIMessage): UIMessage => {
	if (message.role !== "user") return message
	let changed = false
	const parts = message.parts.map((part) => {
		if (part.type !== "text") return part
		const stripped = stripContextPreamble(part.text)
		if (stripped === part.text) return part
		changed = true
		return { ...part, text: stripped }
	})
	return changed ? { ...message, parts } : message
}

/**
 * Thin adapter over `useFlueAgent` exposing the surface `chat-conversation.tsx`
 * consumes. Addresses the org-scoped `maple-chat/<orgId>:<tabId>` agent,
 * reconstructs full history, maps status for the composer, and attaches the
 * per-conversation context preamble to the first message (stripped from the
 * rendered user bubble).
 */
export function useFlueChat({ tabId, context }: UseFlueChatOptions): UseFlueChatResult {
	const { orgId } = useAuth()
	const id = orgId ? `${orgId}:${tabId}` : undefined
	const agent = useFlueAgent({ name: AGENT_NAME, id, history: "all" })

	const messages = useMemo(() => agent.messages.map(cleanForDisplay), [agent.messages])

	const isLoading = agent.status === "submitted" || agent.status === "streaming"

	const sendMessage = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			if (!trimmed) return
			// Only the first message of a fresh conversation carries the preamble.
			const isFirst = agent.messages.length === 0
			const block = isFirst && context ? buildContextPreamble(context) : ""
			const outgoing = block ? wrapContextPreamble(block, trimmed) : trimmed
			void agent.sendMessage(outgoing)
		},
		[agent, context],
	)

	return {
		messages,
		status: toChatStatus(agent.status),
		error: agent.error,
		isLoading,
		sendMessage,
	}
}
