/**
 * The sandbox Worker's bearer check.
 *
 * Its own module because `worker.ts` imports Cloudflare's Sandbox SDK, which
 * cannot be loaded outside a Workers runtime — and this is the one thing between
 * the container and an unauthenticated caller, so it must be testable.
 */

/** Constant-time compare, so the token cannot be recovered a byte at a time. */
export const tokenMatches = (presented: string, expected: string): boolean => {
	if (presented.length !== expected.length) return false
	let diff = 0
	for (let index = 0; index < presented.length; index++)
		diff |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
	return diff === 0
}

/** The bearer token on a request, if it carries one. */
export const bearerToken = (header: string | null): string | undefined =>
	header === null ? undefined : (/^Bearer\s+(.+)$/i.exec(header)?.[1] ?? undefined)

export type SandboxAuthOutcome = "authorized" | "bad-token" | "no-token-configured" | "no-credential"

/** Whether a request may reach the container, and why not when it may not. */
export const authorize = (header: string | null, expected: string | undefined): SandboxAuthOutcome => {
	if (!expected) return "no-token-configured"
	const presented = bearerToken(header)
	if (presented === undefined) return "no-credential"
	return tokenMatches(presented, expected) ? "authorized" : "bad-token"
}
