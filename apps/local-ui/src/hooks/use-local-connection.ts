// Derives the app's connection status from the existing ingest-pulse poll —
// no extra network traffic (React Query dedupes by queryKey). Drives the
// App-level gate that swaps the views for a "how to connect" screen when the
// local binary is unreachable, instead of leaving an infinite skeleton.

import { useLocalIngestPulse } from "./use-local-ingest-pulse"

type LocalConnectionStatus = "connecting" | "connected" | "disconnected"

export interface LocalConnection {
	status: LocalConnectionStatus
	/** Force an immediate probe instead of waiting for the next 5s poll. */
	retry: () => void
}

/**
 * Map the ingest-pulse query state onto a connection status:
 *   - `isError`        → the probe round-trip failed (refused or timed out).
 *   - `data` present   → a probe has succeeded at least once. We key on the
 *                        response *existing*, not on `lastSeenMs`, so a reachable
 *                        but idle backend (`{ lastSeenMs: null }`) reads as
 *                        connected — never disconnected.
 *   - otherwise        → first probe hasn't resolved yet.
 */
export function useLocalConnection(): LocalConnection {
	const { isError, data, refetch } = useLocalIngestPulse()
	const status: LocalConnectionStatus = isError
		? "disconnected"
		: data !== undefined
			? "connected"
			: "connecting"
	return { status, retry: () => void refetch() }
}
