/**
 * Base URL of the Flue chat backend (`apps/chat-flue`). The `@flue/sdk` client
 * mounts its public app at this origin; `useFlueAgent` addresses
 * `maple-chat/<orgId>:<tabId>` under it.
 */
export const flueChatUrl: string = import.meta.env.VITE_FLUE_CHAT_URL ?? "http://localhost:3583"
