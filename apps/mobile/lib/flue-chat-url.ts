// Base URL of the Flue chat backend (`apps/chat-flue`). Dev defaults to the
// `flue dev` port; prod to the chat custom domain. Override with
// EXPO_PUBLIC_FLUE_CHAT_URL.
export const flueChatUrl =
	process.env.EXPO_PUBLIC_FLUE_CHAT_URL ?? (__DEV__ ? "http://127.0.0.1:3583" : "https://chat.maple.dev")

/** The Flue agent module name (`src/agents/maple-chat.ts`). */
export const FLUE_AGENT_NAME = "maple-chat"

/** Flue agent instance id: the org-scoped conversation address. */
export function scopedAgentName(orgId: string, threadId: string): string {
	return `${orgId}:${threadId}`
}
