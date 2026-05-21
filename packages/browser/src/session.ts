const STORAGE_KEY = "maple.session.id"

/**
 * The session id is the correlation key shared by OTel traces and replay
 * events. Generated once per browser session (survives reloads within a tab via
 * sessionStorage), regenerated for a new tab/session.
 */
export function getOrCreateSessionId(): string {
	try {
		const existing = window.sessionStorage.getItem(STORAGE_KEY)
		if (existing) return existing
		const id = crypto.randomUUID()
		window.sessionStorage.setItem(STORAGE_KEY, id)
		return id
	} catch {
		// Private mode / storage disabled — fall back to an ephemeral id.
		return crypto.randomUUID()
	}
}

interface ParsedUserAgent {
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
}

/** Best-effort UA parse — enough to populate filterable session facets. */
export function parseUserAgent(ua: string): ParsedUserAgent {
	const browserName = /edg/i.test(ua)
		? "Edge"
		: /opr|opera/i.test(ua)
			? "Opera"
			: /chrome|crios/i.test(ua)
				? "Chrome"
				: /firefox|fxios/i.test(ua)
					? "Firefox"
					: /safari/i.test(ua)
						? "Safari"
						: "Unknown"
	const osName = /windows/i.test(ua)
		? "Windows"
		: /mac os|macintosh/i.test(ua)
			? "macOS"
			: /android/i.test(ua)
				? "Android"
				: /iphone|ipad|ios/i.test(ua)
					? "iOS"
					: /linux/i.test(ua)
						? "Linux"
						: "Unknown"
	const deviceType = /mobile|iphone|android.*mobile/i.test(ua)
		? "mobile"
		: /ipad|tablet/i.test(ua)
			? "tablet"
			: "desktop"
	return { browserName, osName, deviceType }
}
