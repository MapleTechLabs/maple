import { useState } from "react"
import type { Exit } from "effect"

import { toastExit } from "@/lib/error-toast"

interface DisconnectMessages {
	readonly success: string
	readonly error: string
}

/**
 * Runs an integration's disconnect mutation with a pending flag and an outcome toast.
 * `disconnect()` resolves to whether it succeeded.
 */
export function useIntegrationDisconnect(
	run: () => Promise<Exit.Exit<unknown, unknown>>,
	messages: DisconnectMessages,
): { readonly disconnect: () => Promise<boolean>; readonly pending: boolean } {
	const [pending, setPending] = useState(false)

	async function disconnect() {
		setPending(true)
		const exit = await run()
		setPending(false)
		return toastExit(exit, messages)
	}

	return { disconnect, pending }
}
