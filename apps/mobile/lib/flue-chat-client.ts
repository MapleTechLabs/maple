import { fetch as expoFetch } from "expo/fetch"
import { createFlueClient, type FlueClient } from "@flue/sdk"
import { flueChatUrl } from "./flue-chat-url"

/**
 * Build a `@flue/sdk` client for the chat backend.
 *
 * - `fetch: expoFetch` — RN's built-in fetch can't read streaming response
 *   bodies; `expo/fetch` can, which the Durable-Streams transport needs.
 * - `headers` resolves per request (and per stream reconnect), so it always
 *   attaches a fresh Clerk token; the chat-flue `/agents/*` middleware verifies
 *   it and checks the caller's org owns the addressed instance.
 */
export function makeFlueChatClient(getToken: () => Promise<string | null>): FlueClient {
	return createFlueClient({
		baseUrl: flueChatUrl,
		fetch: expoFetch as unknown as typeof fetch,
		headers: async (): Promise<Record<string, string>> => {
			const token = await getToken()
			return token ? { Authorization: `Bearer ${token}` } : {}
		},
	})
}
