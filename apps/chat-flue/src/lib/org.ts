/**
 * Flue addresses an agent instance by `(agentName, id)`. We encode the tenant in
 * the id as `"<orgId>:<tabId>"` — mirroring the legacy chat-agent Durable Object
 * naming (see apps/chat-agent/src/lib/auth.ts `orgIdFromDoName`) — so the org is
 * recovered server-side from the instance id, never trusted from the request body.
 */
export const orgIdFromInstanceId = (instanceId: string): string | undefined => {
	const idx = instanceId.indexOf(":")
	// Deny-by-default, mirroring the legacy `orgIdFromDoName`: a colon-less id or a
	// leading-colon id carries no resolvable org, so callers must reject it rather
	// than treat the whole string as the org.
	if (idx <= 0) return undefined
	return instanceId.slice(0, idx)
}

/**
 * The tab portion of `"<orgId>:<tabId>"` — everything after the first `:`.
 * Returns `""` when the id carries no tab segment. The tab-id prefix encodes the
 * conversation mode (see modes.ts `modeFromInstanceId`).
 */
export const tabIdFromInstanceId = (instanceId: string): string => {
	const sep = instanceId.indexOf(":")
	return sep === -1 ? "" : instanceId.slice(sep + 1)
}
