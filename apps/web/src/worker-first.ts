import { API_PROXY_PREFIX } from "./api-proxy.ts"

/**
 * Paths the Worker answers before the assets layer. Any other path gets the SPA shell at 200 from
 * `not_found_handling` before `handleRequest` runs, so a route the handler serves itself must be here.
 * Images hand a chat client or crawler HTML in an image slot otherwise (Slack rejects the message).
 */
export const WORKER_FIRST_PATHS: ReadonlyArray<string> = [
	API_PROXY_PREFIX,
	`${API_PROXY_PREFIX}/*`,
	// Share link preview images.
	"/share/og/*",
	// Alert and chat reply chart images.
	"/alerts/chart/*",
	"/chat/chart/*",
]
