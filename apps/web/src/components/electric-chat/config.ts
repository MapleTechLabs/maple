// Endpoints for the Electric-backed comparison chat (/electric-chat).
// - AGENTS_URL: the agents-server (live durable-stream the browser subscribes to).
// - CHAT_REST: the apps/agents Node REST (create room / spawn assistant / send message).
export const AGENTS_URL = import.meta.env.VITE_ELECTRIC_AGENTS_URL ?? "http://localhost:4438"
export const CHAT_REST = import.meta.env.VITE_ELECTRIC_CHAT_REST ?? "http://localhost:4700"

/** The 1:1 assistant entity spawned for a conversation (matches apps/agents spawnAgent). */
export const assistantEntityUrl = (roomId: string) => `/assistant/${roomId}-assistant-1`
