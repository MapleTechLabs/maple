const STORAGE_KEY = "maple.session"

/** Rotate the session after this much inactivity (PostHog's default). */
const IDLE_TIMEOUT_MS = 30 * 60_000
/** Hard cap on a single session's lifetime regardless of activity. */
const MAX_SESSION_MS = 24 * 60 * 60_000

/**
 * A bounded browser session. Persisted in sessionStorage so it survives reloads
 * *within* a tab, but rotated once activity has been idle past `IDLE_TIMEOUT_MS`
 * (or the session is older than `MAX_SESSION_MS`) — the same activity-window
 * model PostHog uses. Bounding the session is what keeps a tab left open for
 * hours from collapsing into one giant replay whose wall-clock length dwarfs the
 * actual active time.
 */
interface SessionRecord {
	id: string
	/** epoch ms — session start, stable across reloads within the window. */
	startedAt: number
	/** epoch ms — bumped on activity; drives idle rotation. */
	lastActivityAt: number
	/** Next replay chunk seq — monotonic across reloads so blobs never collide. */
	chunkSeq: number
}

/** In-memory fallback when sessionStorage is unavailable (private mode). */
let ephemeral: SessionRecord | undefined

function freshRecord(now: number): SessionRecord {
	return { id: crypto.randomUUID(), startedAt: now, lastActivityAt: now, chunkSeq: 0 }
}

function readRecord(): SessionRecord | undefined {
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY)
		if (!raw) return undefined
		const parsed = JSON.parse(raw) as Partial<SessionRecord>
		if (
			typeof parsed.id === "string" &&
			typeof parsed.startedAt === "number" &&
			typeof parsed.lastActivityAt === "number" &&
			typeof parsed.chunkSeq === "number"
		) {
			return parsed as SessionRecord
		}
		return undefined
	} catch {
		return ephemeral
	}
}

function writeRecord(record: SessionRecord): void {
	ephemeral = record
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record))
	} catch {
		// Private mode / storage disabled — the ephemeral copy is the source of truth.
	}
}

function isExpired(record: SessionRecord, now: number): boolean {
	return now - record.lastActivityAt > IDLE_TIMEOUT_MS || now - record.startedAt > MAX_SESSION_MS
}

/**
 * Resolve the active session, rotating to a fresh one if the previous session
 * has gone idle (or hit the lifetime cap). Touches `lastActivityAt` so calling
 * it on page load keeps a live session alive. The id is the correlation key
 * shared by OTel traces and replay events.
 */
export function getSession(): SessionRecord {
	const now = Date.now()
	const existing = readRecord()
	const record =
		existing && !isExpired(existing, now) ? { ...existing, lastActivityAt: now } : freshRecord(now)
	writeRecord(record)
	return record
}

/** Mark the session as active right now (called as replay chunks flush). */
export function markActivity(): void {
	const record = readRecord()
	if (!record) return
	writeRecord({ ...record, lastActivityAt: Date.now() })
}

/**
 * Take the next replay chunk sequence number for the current session. Monotonic
 * across reloads (persisted on the session record), so a refresh continues the
 * sequence instead of restarting at 0 and overwriting the previous load's blobs.
 */
export function nextChunkSeq(): number {
	const record = readRecord() ?? freshRecord(Date.now())
	const seq = record.chunkSeq
	writeRecord({ ...record, chunkSeq: seq + 1 })
	return seq
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
