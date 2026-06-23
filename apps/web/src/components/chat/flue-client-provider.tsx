import { type ReactNode, useMemo } from "react"
import { useAuth } from "@clerk/clerk-react"
import { FlueProvider } from "@flue/react"
import { createFlueClient } from "@flue/sdk"
import { flueChatUrl } from "@/lib/services/common/flue-chat-url"

/**
 * Provides a `@flue/sdk` client to the chat hooks. The `headers` resolver runs
 * per HTTP request (and per Durable-Streams reconnect), so it always attaches a
 * fresh Clerk session token — the chat-flue worker's `/agents/*` middleware
 * verifies it and checks the caller's org owns the addressed instance.
 */
export function FlueClientProvider({ children }: { children: ReactNode }) {
	const { getToken } = useAuth()
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
	return <FlueProvider client={client}>{children}</FlueProvider>
}
