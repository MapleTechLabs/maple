// The app-level connection gate, derived from the server-status poll (no
// extra traffic: React Query dedupes by key). Only a server that is really
// gone swaps the views out; a busy one keeps them and says so in the header.

import { MISSES_BEFORE_DOWN, useLocalServerStatus } from "./use-local-server-status"

export type LocalConnectionStatus = "connecting" | "connected" | "disconnected" | "rejected"

export interface LocalConnection {
	readonly status: LocalConnectionStatus
	/** The server's refusal, when `status` is `rejected`. */
	readonly rejection: { readonly status: number; readonly detail: string } | null
	/** Force an immediate probe instead of waiting for the next poll. */
	readonly retry: () => void
}

export function useLocalConnection(): LocalConnection {
	const { data, isError, refetch } = useLocalServerStatus()
	const retry = () => void refetch()
	if (!data) return { status: isError ? "disconnected" : "connecting", rejection: null, retry }
	switch (data.reachability) {
		case "refused":
			// One refused probe can be a restart in progress; two in a row is down.
			if (data.misses >= MISSES_BEFORE_DOWN) return { status: "disconnected", rejection: null, retry }
			return { status: data.hasConnected ? "connected" : "connecting", rejection: null, retry }
		case "rejected":
			return { status: "rejected", rejection: data.rejection, retry }
		default:
			return { status: "connected", rejection: null, retry }
	}
}
