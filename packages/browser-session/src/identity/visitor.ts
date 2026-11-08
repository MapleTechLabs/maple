import {
	configureCookieScope,
	cookieDomain,
	deleteRawCookie,
	readRawCookie,
	resetCookieScopeForTests,
	setRawCookie,
} from "../platform/cookie"
import { parseJsonObject } from "../platform/json"
import { randomUuid } from "../platform/uuid"
import { clearVisitClaim } from "./visit"

/**
 * A persistent per-browser visitor id.
 *
 * Sessions rotate after 30 minutes idle (see `session.ts`), which makes them
 * useless for "how many people visited" — every long gap mints a new one. The
 * visitor id is the stable identifier that `uniq(VisitorId)` counts, and the
 * only place that knows whether a visitor is new (a self-join against earlier
 * sessions is both a second full scan and wrong past the warehouse's 30-day
 * TTL, which drops the history the join would need).
 *
 * This is a first-party persistent identifier: it requires a cookie/consent
 * notice under ePrivacy, and it is the one thing here that `persistVisitorId:
 * false` and Global Privacy Control turn off.
 *
 * ## Why two stores
 *
 * The id lives in **both** localStorage and a cookie, the same hybrid posthog-js
 * uses for its `localStorage+cookie` persistence:
 *
 * - localStorage is the durable copy. Safari's ITP caps the lifetime of any
 *   cookie set from `document.cookie` at 7 days, so a cookie alone would silently
 *   turn returning visitors into new ones every week.
 * - The cookie is the *cross-subdomain carrier*. localStorage is origin-scoped,
 *   so a marketing site on `example.com` and an app on `app.example.com` can
 *   never see each other's id; a cookie scoped to the registered domain can.
 *   That is what links an anonymous pre-signup visit to the account it becomes.
 *
 * Reads prefer the cookie and mirror the winner back, so an existing
 * localStorage-only visitor converges onto the shared id instead of being reset.
 *
 * ## What is deliberately *not* shared
 *
 * The **session** id stays origin-scoped (sessionStorage, `session.ts`). Unlike
 * PostHog, our `session_replays` table is a ReplacingMergeTree keyed
 * `(OrgId, SessionId)` whose fields resolve by `argMax(field, Version)` over the
 * whole row — two origins posting different ServiceName/EntryPath under one
 * session id would overwrite each other rather than merge. Sessions stay
 * per-surface; `VisitorId` is the join key between them.
 */

const STORAGE_KEY = "maple.visitor"
/**
 * Cookie names cannot contain `.` per RFC 6265's token grammar, so this is not
 * simply `maple.visitor`.
 */
const COOKIE_NAME = "maple_visitor"

/**
 * Match the ~13-month ceiling browsers and privacy regimes settled on for
 * first-party identifiers. Cheap to enforce from the start; retrofitting an
 * expiry onto ids already in the wild is not.
 */
const MAX_AGE_MS = 400 * 24 * 60 * 60_000

interface VisitorRecord {
	id: string
	/** epoch ms — when the id was minted, for the 400-day expiry. */
	mintedAt: number
}

/** Only ids this SDK could have minted; anything else in the cookie is someone else's. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface VisitorState {
	enabled: boolean
	/** Set by `persistVisitorId: false`; sticky, so another SDK copy cannot re-enable it. */
	optedOut: boolean
	/** Memoized so the hot path never re-reads storage. */
	cached: VisitorRecord | undefined
	persisted: boolean
	mintedThisLoad: boolean
}

/**
 * On `globalThis`, like consent: with two bundled SDK copies, per-copy state let
 * one copy's opt-out purge the id while the other minted it straight back.
 */
const VISITOR_KEY = "__MAPLE_BROWSER_VISITOR__"

function visitorState(): VisitorState {
	const owner: Record<string, unknown> = globalThis
	const existing = owner[VISITOR_KEY]
	if (isVisitorState(existing)) return existing
	const fresh: VisitorState = {
		cached: undefined,
		enabled: true,
		mintedThisLoad: false,
		optedOut: false,
		persisted: false,
	}
	owner[VISITOR_KEY] = fresh
	return fresh
}

function isVisitorState(value: unknown): value is VisitorState {
	return typeof value === "object" && value !== null && "optedOut" in value
}

/**
 * Kept under this name because `configurePrivacy` and the SDK tests call it;
 * the domain decision lives in `platform/cookie.ts`, shared with the visit claim.
 */
export const configureVisitorCookie = configureCookieScope

export function parseVisitorRecord(raw: string | null | undefined): VisitorRecord | undefined {
	if (!raw) return undefined
	const value = parseJsonObject(raw)
	if (!value) return undefined
	const { id, mintedAt } = value
	if (typeof id !== "string" || !UUID.test(id)) return undefined
	if (typeof mintedAt !== "number" || !Number.isFinite(mintedAt)) return undefined
	if (Date.now() - mintedAt > MAX_AGE_MS) return undefined
	return { id, mintedAt }
}

function readFromStorage(): VisitorRecord | undefined {
	try {
		return parseVisitorRecord(window.localStorage.getItem(STORAGE_KEY))
	} catch {
		return undefined
	}
}

function readFromCookie(): VisitorRecord | undefined {
	return parseVisitorRecord(readRawCookie(COOKIE_NAME))
}

function writeToStorage(record: VisitorRecord): boolean {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
		return true
	} catch {
		// Safari private mode / storage blocked.
		return false
	}
}

/**
 * Mirror the record into the cookie. The max-age is the id's *remaining* life,
 * not a fresh 400 days, so re-writing it on every page load can't turn the
 * expiry into a sliding window that never fires.
 */
function writeToCookie(record: VisitorRecord): boolean {
	const remainingMs = MAX_AGE_MS - (Date.now() - record.mintedAt)
	if (remainingMs <= 0) return false
	return setRawCookie(COOKIE_NAME, JSON.stringify(record), cookieDomain(), remainingMs / 1000)
}

function write(record: VisitorRecord): void {
	const inStorage = writeToStorage(record)
	const inCookie = writeToCookie(record)
	// The in-memory id still keeps every row from this page load consistent,
	// which beats sending '' — but with neither store it is not a real visitor
	// id, and `isVisitorIdPersisted()` says so.
	visitorState().persisted = inStorage || inCookie
}

/**
 * The current visitor id, minting one on first use. `undefined` when visitor
 * tracking is off or outside a browser.
 */
export function getVisitorId(): string | undefined {
	const state = visitorState()
	if (!state.enabled || state.optedOut || typeof window === "undefined") return undefined
	if (state.cached) return state.cached.id

	const fromCookie = readFromCookie()
	const fromStorage = readFromStorage()
	// The cookie wins: it is the copy shared across subdomains, so a visitor who
	// already has one on the marketing site keeps that identity in the app rather
	// than the app's older origin-local id.
	const existing = fromCookie ?? fromStorage
	if (existing) {
		state.cached = existing
		state.persisted = true
		// Converge the two stores on the winner. Best-effort — one of them already
		// holds the id, so a failure here doesn't make it any less persistent.
		if (!fromCookie) writeToCookie(existing)
		if (!fromStorage || fromStorage.id !== existing.id) writeToStorage(existing)
		return existing.id
	}

	const record: VisitorRecord = {
		id: randomUuid(),
		mintedAt: Date.now(),
	}
	state.cached = record
	state.mintedThisLoad = true
	write(record)
	return record.id
}

/**
 * Claim the "this visitor was minted just now" flag for the session being
 * created — drives new vs returning without a self-join. Reading it mints the
 * id if needed, so callers get an answer consistent with `getVisitorId()`.
 *
 * One-shot on purpose. The flag is page-load scoped, but sessions are not: a
 * page load can both start a session and (30 minutes idle later) rotate into a
 * second one, and only the first of those belongs to a new visitor. The
 * claimed value is persisted on the session record, which is also what keeps a
 * reload from re-answering the question — see `session.ts`.
 */
export function claimNewVisitor(): boolean {
	getVisitorId()
	const state = visitorState()
	if (!state.mintedThisLoad) return false
	state.mintedThisLoad = false
	return true
}

/**
 * Whether the id actually survives this page load. `false` means both stores
 * were blocked and the id is in-memory only, so uniques would be over-counted;
 * the metadata row carries this as `maple.visitor.persisted` so the analytics
 * layer can flag it rather than quietly inflate.
 */
export function isVisitorIdPersisted(): boolean {
	return visitorState().persisted
}

/**
 * Turn persistent visitor tracking on or off. Turning it off also purges any
 * id already stored — an opt-out that leaves the identifier behind is not one.
 */
export function setVisitorTracking(nextEnabled: boolean): void {
	visitorState().enabled = nextEnabled
	if (!nextEnabled) purgeVisitorId()
}

/**
 * `persistVisitorId: false` from any SDK on the page. Unlike `setVisitorTracking`,
 * which follows consent both ways, this never turns back on for the page load.
 */
export function optOutOfVisitorId(): void {
	visitorState().optedOut = true
	purgeVisitorId()
}

/** Drop the id and the visit claim from memory and every store. */
export function purgeVisitorId(): void {
	const state = visitorState()
	state.cached = undefined
	state.persisted = false
	state.mintedThisLoad = false
	if (typeof window === "undefined") return
	try {
		window.localStorage.removeItem(STORAGE_KEY)
	} catch {
		// Nothing to purge if storage is unavailable.
	}
	// Expire on both the shared domain and host-only: the cookie may have been
	// written before `configureVisitorCookie` narrowed the scope, and a delete
	// that misses the actual cookie is not a delete.
	deleteRawCookie(COOKIE_NAME)
	clearVisitClaim()
}

/** Test seam — drops the memoized id and any opt-out without touching storage. */
export function resetVisitorCacheForTests(): void {
	const state = visitorState()
	state.cached = undefined
	state.persisted = false
	state.mintedThisLoad = false
	state.enabled = true
	state.optedOut = false
	resetCookieScopeForTests()
}
