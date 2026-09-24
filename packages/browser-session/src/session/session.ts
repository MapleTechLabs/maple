import { claimNewVisitor } from "../identity/visitor"
import { isStringRecord, parseJsonObject } from "../platform/json"
import { scrubUrl } from "../platform/url-privacy"

const STORAGE_KEY = "maple.session"

/** Rotate the session after this much inactivity (PostHog's default). */
const IDLE_TIMEOUT_MS = 30 * 60_000
/** Hard cap on a single session's lifetime regardless of activity. */
const MAX_SESSION_MS = 24 * 60 * 60_000
/**
 * The activity path runs per span creation (`getSessionId`) and per captured
 * event (`markActivity` — every console call, keystroke, click, fetch);
 * persisting the bump on every call would hammer sessionStorage for no benefit
 * — rotation correctness only needs sub-idle-timeout granularity.
 */
const ACTIVITY_TOUCH_THROTTLE_MS = 5_000

/**
 * A bounded browser session. Persisted in sessionStorage so it survives reloads
 * *within* a tab, but rotated once activity has been idle past `IDLE_TIMEOUT_MS`
 * (or the session is older than `MAX_SESSION_MS`) — the same activity-window
 * model PostHog uses. Bounding the session is what keeps a tab left open for
 * hours from collapsing into one giant replay whose wall-clock length dwarfs the
 * actual active time.
 */
export interface SessionRecord {
	id: string
	/** epoch ms — session start, stable across reloads within the window. */
	startedAt: number
	/** epoch ms — bumped on activity; drives idle rotation. */
	lastActivityAt: number
	/**
	 * Next replay chunk seq — monotonic across reloads so blobs never collide.
	 * Only `@maple-dev/browser`'s replay recorder consumes it, but it is part of
	 * the persisted record shape every writer must preserve: `readRecord`
	 * rejects records where it is missing.
	 */
	chunkSeq: number
	/**
	 * Last session-metadata row version issued for this session. The backend
	 * resolves each field with `argMax(field, Version)`, so versions must be
	 * strictly increasing across every writer (either SDK, across reloads and
	 * hide/resume cycles) for the latest row to win. Optional for
	 * backwards-compat with records written before it existed — those already
	 * used versions 1 (active) and 2 (ended), so the absent case resumes at 2.
	 */
	metaVersion?: number

	// All optional: `readRecord`'s validator deliberately still accepts records
	// written by older SDKs, which have none of these.
	//
	// Entry fields are captured once, in `freshRecord`, and then never change —
	// so they are identical on every metadata row version, which matters because
	// ReplacingMergeTree replaces the whole row rather than merging fields.

	/** Full URL of the first page of this session. */
	entryUrl?: string
	/** `document.referrer` as seen on that first page. */
	entryReferrer?: string
	/** utm_* query params from the entry URL. */
	utm?: Record<string, string>
	/**
	 * Whether the visitor id was minted when this session started.
	 *
	 * Persisted rather than re-derived per metadata row because "new" is a fact
	 * about the session, not about the page load: the flag lives in memory, a
	 * reload clears it, and the backend is a ReplacingMergeTree that keeps the
	 * *latest* row wholesale — so a re-derived value would silently rewrite a
	 * new visitor's session into a returning one on the first refresh.
	 */
	visitorIsNew?: boolean
	/** Most recent URL seen — becomes `exit_path`. */
	lastUrl?: string
	/** Navigations seen this session. `<= 1` is a bounce. */
	pageViews?: number
	clickCount?: number
	errorCount?: number
	/**
	 * Whether this session records replay. Decided once per session, not per
	 * page load: re-rolling on every load split one session into recorded and
	 * unrecorded pages, and the latest metadata row (which wins) could label a
	 * recorded session "Not recorded".
	 */
	replaySampled?: boolean
}

/** Optional keys carrying a plain number. Absent is fine; wrongly typed is not. */
const OPTIONAL_NUMBERS = ["metaVersion", "pageViews", "clickCount", "errorCount"] as const
/** Optional keys carrying a plain string. */
const OPTIONAL_STRINGS = ["entryUrl", "entryReferrer", "lastUrl"] as const

/**
 * Validate a persisted session record. Deliberately still accepts records
 * written by older SDKs, which have none of the optional fields — see the
 * `SessionRecord` field comments.
 *
 * Returns `undefined` rather than throwing: the sole caller treats a corrupt
 * record exactly as it treats unreadable storage.
 */
function parseSessionRecord(raw: string): SessionRecord | undefined {
	const value = parseJsonObject(raw)
	if (!value) return undefined

	const { id, startedAt, lastActivityAt, chunkSeq } = value
	if (
		typeof id !== "string" ||
		typeof startedAt !== "number" ||
		typeof lastActivityAt !== "number" ||
		typeof chunkSeq !== "number"
	) {
		return undefined
	}

	// Rebuilt key by key rather than spread, so an unknown key written by a
	// newer SDK is dropped instead of riding along into the typed record.
	const record: SessionRecord = { id, startedAt, lastActivityAt, chunkSeq }

	for (const key of OPTIONAL_NUMBERS) {
		const entry = value[key]
		if (entry === undefined) continue
		if (typeof entry !== "number") return undefined
		record[key] = entry
	}
	for (const key of OPTIONAL_STRINGS) {
		const entry = value[key]
		if (entry === undefined) continue
		if (typeof entry !== "string") return undefined
		record[key] = entry
	}
	if (value.visitorIsNew !== undefined) {
		if (typeof value.visitorIsNew !== "boolean") return undefined
		record.visitorIsNew = value.visitorIsNew
	}
	if (value.replaySampled !== undefined) {
		if (typeof value.replaySampled !== "boolean") return undefined
		record.replaySampled = value.replaySampled
	}
	if (value.utm !== undefined) {
		if (!isStringRecord(value.utm)) return undefined
		record.utm = value.utm
	}
	return record
}

/** The immutable acquisition context of a session. */
export interface EntryContext {
	readonly entryUrl: string
	readonly referrer: string
	readonly utm: Record<string, string>
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const

/** In-memory fallback when sessionStorage is unavailable (private mode). */
let ephemeral: SessionRecord | undefined

export type SessionRotationListener = (previous: SessionRecord, next: SessionRecord) => void
const rotationListeners = new Set<SessionRotationListener>()

/**
 * Read the entry URL/referrer/UTM of the current page.
 *
 * Guarded for non-DOM runtimes: `freshRecord` is reachable from `getSessionId`
 * on the span path and from the `nextChunkSeq`/`nextMetaVersion` fallbacks, so
 * this must not assume `location`/`document` exist.
 */
function readEntryContext(): Partial<SessionRecord> {
	if (typeof window === "undefined" || typeof location === "undefined") return {}
	const utm: Record<string, string> = {}
	try {
		const params = new URLSearchParams(location.search)
		for (const key of UTM_KEYS) {
			const value = params.get(key)?.trim()
			// Bounded because UtmSource/Medium/Campaign are LowCardinality columns.
			if (value) utm[key] = value.slice(0, 128)
		}
	} catch {
		// Malformed query string — no UTM, not a failure.
	}
	const href = scrubUrl(location.href)
	return {
		entryUrl: href,
		entryReferrer: typeof document !== "undefined" ? scrubUrl(document.referrer) : "",
		utm,
		lastUrl: href,
		pageViews: 0,
		clickCount: 0,
		errorCount: 0,
	}
}

function freshRecord(now: number): SessionRecord {
	return {
		id: crypto.randomUUID(),
		startedAt: now,
		lastActivityAt: now,
		chunkSeq: 0,
		metaVersion: 0,
		// Claimed once, at session creation, so exactly one session per minted
		// visitor id is the "new visitor" one — and so a reload, which re-derives
		// nothing, cannot downgrade it.
		visitorIsNew: claimNewVisitor(),
		...readEntryContext(),
	}
}

function readRecord(): SessionRecord | undefined {
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY)
		if (!raw) return undefined
		// A corrupt record falls back to the in-memory copy, exactly as an
		// unreadable sessionStorage does — it is the same loss of the durable copy.
		return parseSessionRecord(raw) ?? ephemeral
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
	claimTab(record.id)
}

// Duplicate-tab detection.
//
// "Duplicate tab" and `window.open` with an opener copy sessionStorage, so the
// new tab would resume the same session id and the same `chunkSeq`. Both tabs
// then upload chunk N under one key and overwrite each other, and the replay
// interleaves two DOMs. Each tab (not each SDK copy: the nonce lives on
// `globalThis`) leases the session it writes in localStorage; a tab that finds
// a live lease held by someone else starts its own session.
//
// A reload is not a duplicate: `pagehide` releases the lease before the next
// document reads it. A lease is live for `TAB_LEASE_TTL_MS` after its last
// write, which covers the 60s heartbeat of a visible tab; a crashed tab's lease
// simply ages out.
const TAB_LEASE_PREFIX = "maple.session.tab."
const TAB_LEASE_TTL_MS = 2 * 60_000
const TAB_LEASE_REFRESH_MS = 5_000
const TAB_NONCE_KEY = "__MAPLE_TAB_NONCE__"

/** The session id this tab has checked (or minted) and may keep using. */
let verifiedSessionId: string | undefined
let leaseWrittenAt = 0
let releaseInstalled = false
/**
 * Set from `pagehide` until the page is shown again. The lifecycle's own
 * `pagehide` handler posts an `ended` row after ours runs, which writes the
 * record; re-leasing there would make the next load of this tab look like a
 * duplicate and rotate on every reload.
 */
let leaseReleased = false

function tabNonce(): string {
	const owner = globalThis as Record<string, unknown>
	const existing = owner[TAB_NONCE_KEY]
	if (typeof existing === "string") return existing
	const fresh = crypto.randomUUID()
	owner[TAB_NONCE_KEY] = fresh
	return fresh
}

function leaseStorage(): Storage | undefined {
	try {
		return typeof window !== "undefined" ? window.localStorage : undefined
	} catch {
		return undefined
	}
}

function readLease(storage: Storage, sessionId: string): { nonce: string; at: number } | undefined {
	const raw = storage.getItem(`${TAB_LEASE_PREFIX}${sessionId}`)
	if (!raw) return undefined
	const split = raw.lastIndexOf(":")
	const at = Number(raw.slice(split + 1))
	return split > 0 && Number.isFinite(at) ? { nonce: raw.slice(0, split), at } : undefined
}

function claimTab(sessionId: string): void {
	const now = Date.now()
	if (verifiedSessionId === sessionId && now - leaseWrittenAt < TAB_LEASE_REFRESH_MS) return
	if (verifiedSessionId !== undefined && verifiedSessionId !== sessionId) releaseTab(verifiedSessionId)
	verifiedSessionId = sessionId
	if (leaseReleased) return
	leaseWrittenAt = now
	const storage = leaseStorage()
	if (!storage) return
	try {
		storage.setItem(`${TAB_LEASE_PREFIX}${sessionId}`, `${tabNonce()}:${now}`)
	} catch {
		// Storage full or blocked: detection degrades, capture does not.
	}
	installLeaseRelease()
}

function releaseTab(sessionId: string): void {
	const storage = leaseStorage()
	if (!storage) return
	try {
		if (readLease(storage, sessionId)?.nonce === tabNonce()) {
			storage.removeItem(`${TAB_LEASE_PREFIX}${sessionId}`)
		}
	} catch {
		// Best-effort.
	}
}

function installLeaseRelease(): void {
	if (releaseInstalled || typeof globalThis.addEventListener !== "function") return
	releaseInstalled = true
	globalThis.addEventListener("pagehide", () => {
		leaseReleased = true
		if (verifiedSessionId !== undefined) releaseTab(verifiedSessionId)
	})
	// A bfcache restore is the same tab coming back: lease again on next write.
	globalThis.addEventListener("pageshow", () => {
		leaseReleased = false
		leaseWrittenAt = 0
	})
}

/** Drop leases a crashed tab never released. */
function pruneLeases(storage: Storage, now: number): void {
	for (let i = storage.length - 1; i >= 0; i--) {
		const key = storage.key(i)
		if (!key?.startsWith(TAB_LEASE_PREFIX)) continue
		const lease = readLease(storage, key.slice(TAB_LEASE_PREFIX.length))
		if (!lease || now - lease.at > TAB_LEASE_TTL_MS) storage.removeItem(key)
	}
}

/**
 * Whether another live tab holds `record`'s session. Checked once per session
 * id per tab; after that this tab has claimed it.
 */
function ownedByAnotherTab(record: SessionRecord, now: number): boolean {
	if (verifiedSessionId === record.id) return false
	const storage = leaseStorage()
	if (!storage) return false
	try {
		pruneLeases(storage, now)
		const lease = readLease(storage, record.id)
		return lease !== undefined && lease.nonce !== tabNonce() && now - lease.at <= TAB_LEASE_TTL_MS
	} catch {
		return false
	}
}

/** Test seam: forget this tab's lease state. */
export function resetTabLeaseForTests(): void {
	verifiedSessionId = undefined
	leaseWrittenAt = 0
	leaseReleased = false
}

export function isSessionExpired(record: SessionRecord, now = Date.now()): boolean {
	return now - record.lastActivityAt > IDLE_TIMEOUT_MS || now - record.startedAt > MAX_SESSION_MS
}

/** Observe genuine idle/lifetime rotation. Invoked before the new record is installed. */
export function onSessionRotate(listener: SessionRotationListener): () => void {
	rotationListeners.add(listener)
	return () => rotationListeners.delete(listener)
}

/**
 * Upgrade an in-flight session written by an older SDK. The visitor feature
 * can land while a tab still has the old record in sessionStorage; claiming
 * newness here makes that current session the new visitor's session and
 * consumes the one-shot claim so a later idle rotation cannot steal it.
 */
function migrateRecord(record: SessionRecord): SessionRecord {
	return record.visitorIsNew === undefined ? { ...record, visitorIsNew: claimNewVisitor() } : record
}

function installRotatedRecord(previous: SessionRecord | undefined, next: SessionRecord): void {
	if (previous) {
		for (const listener of rotationListeners) {
			try {
				listener(previous, next)
			} catch {
				// Rotation is storage-critical. A lifecycle observer must not keep an
				// expired id alive or prevent the other owners from rotating with it.
			}
		}
	}
	writeRecord(next)
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
	if (existing && !isSessionExpired(existing, now) && !ownedByAnotherTab(existing, now)) {
		const record = { ...migrateRecord(existing), lastActivityAt: now }
		writeRecord(record)
		return record
	}
	const record = freshRecord(now)
	installRotatedRecord(existing, record)
	return record
}

/** Force a new session boundary (used after a consent revoke/re-grant cycle). */
export function rotateSession(): SessionRecord | undefined {
	if (typeof window === "undefined") return undefined
	const previous = readRecord()
	const next = freshRecord(Date.now())
	installRotatedRecord(previous, next)
	return next
}

/**
 * Resolve the active session, rotating when the stored one has expired, and
 * persist the activity bump only once it has gone stale by
 * `ACTIVITY_TOUCH_THROTTLE_MS`. Shared by the two hot-path entry points so a
 * chatty page doesn't pay a sessionStorage read *and* write per span/event.
 */
function touchSession(now: number): SessionRecord {
	const existing = readRecord()
	if (existing && !isSessionExpired(existing, now) && !ownedByAnotherTab(existing, now)) {
		const migrated = migrateRecord(existing)
		const touched = { ...migrated, lastActivityAt: now }
		if (
			migrated !== existing ||
			verifiedSessionId !== existing.id ||
			now - existing.lastActivityAt > ACTIVITY_TOUCH_THROTTLE_MS
		) {
			writeRecord(touched)
		}
		return touched
	}
	const record = freshRecord(now)
	installRotatedRecord(existing, record)
	return record
}

/**
 * Resolve the active session id, minting/rotating as needed. Safe to call per
 * span: the activity touch is throttled. Returns `undefined` outside a browser
 * DOM (SSR, React Native), where browser sessions must not be minted.
 */
export function getSessionId(): string | undefined {
	if (typeof window === "undefined" || typeof document === "undefined") return undefined
	return touchSession(Date.now()).id
}

/**
 * Mark activity, rotating first when the stored session has expired. Called per
 * captured event, so it shares `getSessionId`'s throttled touch — callers read
 * the returned record's `id` to detect that rotation.
 */
export function markActivity(): SessionRecord | undefined {
	if (typeof window === "undefined") return undefined
	return touchSession(Date.now())
}

/**
 * Record a page view. Persisted on the session record rather than held in the
 * capture loop's memory so the count survives reloads within the session — a
 * two-page visit split by a refresh is not a bounce.
 */
export function noteNavigation(url: string): void {
	if (typeof window === "undefined") return
	const now = Date.now()
	const record = touchSession(now)
	writeRecord({
		...record,
		lastUrl: scrubUrl(url),
		pageViews: (record.pageViews ?? 0) + 1,
		lastActivityAt: now,
	})
}

/** Accumulate interaction/error counts onto the persisted session record. */
export function noteCounts(counts: { clickCount?: number; errorCount?: number }): void {
	const record = readRecord()
	if (!record) return
	writeRecord({
		...record,
		clickCount: counts.clickCount ?? record.clickCount ?? 0,
		errorCount: counts.errorCount ?? record.errorCount ?? 0,
	})
}

/**
 * The persisted session record as-is — no activity touch, no rotation. Use
 * this to read counters when posting a metadata row; `getSession()` would
 * rotate an idle session out from under the row being written.
 */
export function peekSession(): SessionRecord | undefined {
	return readRecord()
}

/**
 * Whether the current session belongs to a first-time visitor. Read off the
 * persisted record, so every metadata row of a session answers identically no
 * matter how many reloads or heartbeats it spans.
 */
export function isNewVisitorSession(): boolean {
	const record = readRecord()
	if (!record) return false
	const migrated = migrateRecord(record)
	if (migrated !== record) writeRecord(migrated)
	return migrated.visitorIsNew === true
}

/**
 * The acquisition context carried by a record. Takes the record rather than
 * re-reading storage, because every caller already holds one — the metadata
 * lifecycle posts from it.
 */
export function entryContextOf(record: SessionRecord): EntryContext {
	return {
		entryUrl: record.entryUrl ?? "",
		referrer: record.entryReferrer ?? "",
		utm: record.utm ?? {},
	}
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

/**
 * Take the next session-metadata row version for the current session.
 * Monotonic per session across reloads, hide/resume cycles, and writers (both
 * SDKs share the persisted counter), so `argMax(field, Version)` on the
 * backend always resolves to the most recently posted row. Records written by
 * older SDKs (no `metaVersion`) already posted versions 1 and 2, so the
 * counter resumes at 3 for them; a fresh session starts at 1.
 */
export function nextMetaVersion(): number {
	const record = readRecord() ?? freshRecord(Date.now())
	const version = (record.metaVersion ?? 2) + 1
	writeRecord({ ...record, metaVersion: version })
	return version
}

/**
 * This session's replay sampling decision, rolled against `sampleRate` the
 * first time it is asked and then persisted, so every page load of the session
 * agrees. Call after `getSession()` has resolved the session.
 */
export function claimReplaySample(sampleRate: number): boolean {
	const record = readRecord() ?? getSession()
	if (record.replaySampled !== undefined) return record.replaySampled
	const sampled = Math.random() < sampleRate
	writeRecord({ ...record, replaySampled: sampled })
	return sampled
}

/**
 * Pin a session to the capture mode a running page is already in. A session
 * minted by idle rotation mid-page inherits that page's mode rather than
 * rolling again, and later loads of it honour the same answer.
 */
export function adoptReplayDecision(sessionId: string, recorded: boolean): void {
	const record = readRecord()
	if (!record || record.id !== sessionId || record.replaySampled !== undefined) return
	writeRecord({ ...record, replaySampled: recorded })
}
