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
import { IDLE_TIMEOUT_MS } from "../session/idle"

const STORAGE_KEY = "maple.visit"
/** Cookie names cannot contain `.` per RFC 6265's token grammar. */
const COOKIE_NAME = "maple_visit"

/** In-memory copy: all a page load has when persistence is off or blocked. */
let ephemeral: number | undefined

function parseMarker(raw: string | null | undefined): number | undefined {
	if (!raw) return undefined
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) ? parsed : undefined
}

function readMarker(persist: boolean): number | undefined {
	if (!persist) return ephemeral
	// Cookie first: it is the copy shared across subdomains.
	const fromCookie = parseMarker(readRawCookie(COOKIE_NAME))
	if (fromCookie !== undefined) return fromCookie
	try {
		const fromStorage = parseMarker(window.localStorage.getItem(STORAGE_KEY))
		if (fromStorage !== undefined) return fromStorage
	} catch {
		// Storage blocked: fall through to the in-memory copy.
	}
	return ephemeral
}

function writeMarker(at: number, persist: boolean): void {
	ephemeral = at
	if (!persist) return
	const value = String(at)
	try {
		window.localStorage.setItem(STORAGE_KEY, value)
	} catch {
		// Private mode / quota: the cookie and the in-memory copy still stand.
	}
	setRawCookie(COOKIE_NAME, value, cookieDomain(), (IDLE_TIMEOUT_MS - (Date.now() - at)) / 1000)
}

function withinVisit(marker: number | undefined, at: number): marker is number {
	return marker !== undefined && Math.abs(at - marker) < IDLE_TIMEOUT_MS
}

/**
 * Claim the visit `at` belongs to, returning whether this caller is the one
 * charged for it. `persist` is false when visitor tracking is off, which keeps
 * the claim in memory: no identifier-adjacent cookie the host app opted out of.
 */
export function claimVisit(at: number, persist: boolean): boolean {
	if (typeof window === "undefined") return false
	const marker = readMarker(persist)
	if (withinVisit(marker, at)) {
		if (at > marker) writeMarker(at, persist)
		return false
	}
	writeMarker(at, persist)
	return true
}

/** Extend the current visit to `at`. Never opens one: only `claimVisit` does. */
export function touchVisit(at: number, persist: boolean): void {
	if (typeof window === "undefined") return
	const marker = readMarker(persist)
	if (withinVisit(marker, at) && at > marker) writeMarker(at, persist)
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
