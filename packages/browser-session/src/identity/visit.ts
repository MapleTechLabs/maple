/**
 * The billable unit: one visit per visitor per idle window, across every tab and
 * subdomain. `SessionId` cannot be that unit: sessionStorage scopes it to one
 * tab and one origin, and it must stay that way because `session_replays`
 * resolves each `(OrgId, SessionId)` by `argMax(field, Version)` over the whole
 * row, so two tabs sharing an id would overwrite each other.
 *
 * The marker is the visit's latest activity, not the moment it was claimed:
 * active tabs keep extending it, so a tab opened an hour into a busy visit is
 * not a second charge, and 30 idle minutes (a session rotation) start a new one.
 */

import { cookieDomain, deleteRawCookie, readRawCookie, setRawCookie } from "../platform/cookie"
import { randomUuid } from "../platform/uuid"
import { IDLE_TIMEOUT_MS } from "../session/idle"

const STORAGE_KEY = "maple.visit"
/** Cookie names cannot contain `.` per RFC 6265's token grammar. */
const COOKIE_NAME = "maple_visit"

/**
 * The latest activity in the visit, plus a random token naming the tab that
 * opened it. Stored as `<at>.<token>`; a bare `<at>` is what older builds wrote.
 */
interface Marker {
	readonly at: number
	readonly token: string
}

/** In-memory copy: all a page load has when persistence is off or blocked. */
let ephemeral: Marker | undefined

export function parseVisitMarker(raw: string | null | undefined): Marker | undefined {
	if (!raw) return undefined
	const match = /^(\d{1,16})(?:\.([0-9a-z]{1,32}))?$/.exec(raw)
	if (!match?.[1]) return undefined
	return { at: Number(match[1]), token: match[2] ?? "" }
}

function readMarker(persist: boolean): Marker | undefined {
	if (!persist) return ephemeral
	// Cookie first: it is the copy shared across subdomains.
	const fromCookie = parseVisitMarker(readRawCookie(COOKIE_NAME))
	if (fromCookie !== undefined) return fromCookie
	try {
		const fromStorage = parseVisitMarker(window.localStorage.getItem(STORAGE_KEY))
		if (fromStorage !== undefined) return fromStorage
	} catch {
		// Storage blocked: fall through to the in-memory copy.
	}
	return ephemeral
}

function writeMarker(marker: Marker, persist: boolean): void {
	ephemeral = marker
	if (!persist) return
	const value = marker.token ? `${marker.at}.${marker.token}` : String(marker.at)
	try {
		window.localStorage.setItem(STORAGE_KEY, value)
	} catch {
		// Private mode / quota: the cookie and the in-memory copy still stand.
	}
	setRawCookie(COOKIE_NAME, value, cookieDomain(), (IDLE_TIMEOUT_MS - (Date.now() - marker.at)) / 1000)
}

function withinVisit(marker: Marker | undefined, at: number): marker is Marker {
	return marker !== undefined && Math.abs(at - marker.at) < IDLE_TIMEOUT_MS
}

/**
 * Claim the visit `at` belongs to, returning whether this caller is the one
 * charged for it. `persist` is false when visitor tracking is off, which keeps
 * the claim in memory: no identifier-adjacent cookie the host app opted out of.
 *
 * Restored tabs all start at once and can each read "no visit" before any of
 * them writes one. Each writes its own token and reads the marker back, and
 * only the tab whose token survived is charged: the last writer wins.
 */
export function claimVisit(at: number, persist: boolean): boolean {
	if (typeof window === "undefined") return false
	const marker = readMarker(persist)
	if (withinVisit(marker, at)) {
		if (at > marker.at) writeMarker({ at, token: marker.token }, persist)
		return false
	}
	const token = randomUuid().slice(0, 8)
	writeMarker({ at, token }, persist)
	return readMarker(persist)?.token === token
}

/** Extend the current visit to `at`. Never opens one: only `claimVisit` does. */
export function touchVisit(at: number, persist: boolean): void {
	if (typeof window === "undefined") return
	const marker = readMarker(persist)
	if (withinVisit(marker, at) && at > marker.at) writeMarker({ at, token: marker.token }, persist)
}

/** Drop the claim from every store, for a visitor-tracking opt-out. */
export function clearVisitClaim(): void {
	ephemeral = undefined
	try {
		window.localStorage.removeItem(STORAGE_KEY)
	} catch {
		// Nothing to purge if storage is unavailable.
	}
	deleteRawCookie(COOKIE_NAME)
}

/** Test seam: drops the in-memory claim without touching storage. */
export function resetVisitClaimForTests(): void {
	ephemeral = undefined
}
