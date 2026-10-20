/**
 * URL-safe base64 helpers for round-tripping JSON payloads through search
 * params. Works in both the browser (atob/btoa) and SSR (Buffer); the
 * escape/decodeURIComponent dance keeps non-ASCII content intact.
 */
export const fromBase64Url = (input: string): string => {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/")
	const pad = padded.length % 4
	const full = pad === 0 ? padded : padded + "=".repeat(4 - pad)
	if (typeof atob !== "undefined") {
		try {
			return decodeURIComponent(escape(atob(full)))
		} catch {
			return atob(full)
		}
	}
	return Buffer.from(full, "base64").toString("utf8")
}
