export const chatAgentUrl: string = import.meta.env.VITE_CHAT_AGENT_URL ?? "http://localhost:8787"

/**
 * Base URL of the Flue chat worker (apps/chat-flue), which mounts the Flue app at
 * root. Used by the `useFlueChat` adapter (Phase 2 rework). Defaults to the
 * `flue dev` port. The legacy `chatAgentUrl` stays until cutover.
 */
export const flueChatUrl: string = import.meta.env.VITE_FLUE_CHAT_URL ?? "http://localhost:3583"
