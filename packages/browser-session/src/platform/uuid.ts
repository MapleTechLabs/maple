/**
 * A random v4 UUID. `crypto.randomUUID` exists only in secure contexts (HTTPS
 * and localhost) and from Safari 15.4, so a plain-http intranet or staging site
 * would otherwise throw from `init()`. `getRandomValues` has no such limit.
 */
export function randomUuid(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
