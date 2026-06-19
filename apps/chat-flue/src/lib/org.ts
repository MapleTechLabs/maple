/**
 * Flue addresses an agent instance by `(agentName, id)`. We encode the tenant in
 * the id as `"<orgId>:<tabId>"` — mirroring the legacy chat-agent Durable Object
 * naming (see apps/chat-agent/src/lib/auth.ts `orgIdFromDoName`) — so the org is
 * recovered server-side from the instance id, never trusted from the request body.
 */
export const orgIdFromInstanceId = (instanceId: string): string => {
	const sep = instanceId.indexOf(":")
	return sep === -1 ? instanceId : instanceId.slice(0, sep)
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
