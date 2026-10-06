import type { Exit } from "effect"

import { useAsyncAction } from "@/hooks/use-mutation-action"
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
	const [disconnect, pending] = useAsyncAction(async () => toastExit(await run(), messages))

	return { disconnect, pending }
}
