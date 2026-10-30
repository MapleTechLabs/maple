/**
 * Consent gating for session capture.
 *
 * The posture, deliberately:
 *
 * - `requireConsent` defaults to **false**. Flipping that default would
 *   silently stop telemetry for every existing install — an availability
 *   incident dressed up as a privacy win. Apps that need a consent gate opt in.
 * - Global Privacy Control **is** honored by default, but only against the
 *   persistent visitor id, not the session itself. GPC is a legally recognized
 *   signal in several US states and it maps exactly onto the one cross-session
 *   identifier this SDK stores; the session-scoped capture that powers replay
 *   and error triage is unaffected.
 * - `doNotTrack` is **not** honored by default. It is deprecated, removed from
 *   Safari, and ignored across the industry, so respecting it would mostly mean
 *   dropping data from users who never intended to opt out. Apps can turn it on.
 */

import {
	configurePersistence,
	mayUseStorage,
	type Persistence,
	resetPersistenceForTests,
} from "../platform/persistence"
import { addUrlSanitizer, resetUrlSanitizersForTests } from "../platform/url-privacy"
import {
	configureVisitorCookie,
	optOutOfVisitorId,
	purgeVisitorId,
	resetVisitorCacheForTests,
} from "./visitor"

export interface PrivacyOptions {
	/** Capture nothing until `setConsent(true)`. Default false. */
	readonly requireConsent?: boolean
	/** Store a persistent visitor id. Default true. */
	readonly persistVisitorId?: boolean
	/**
	 * `"memory"` keeps every SDK state in memory: no cookies, Web Storage or
	 * IndexedDB, and no visitor id. A reload starts a new session. Default
	 * `"browser"`.
	 */
	readonly persistence?: Persistence
	/**
	 * Scope the visitor-id cookie to the registered domain so a marketing site
	 * and an app on sibling subdomains resolve to the same visitor. Default true.
	 * Set false to keep the cookie host-only.
	 */
	readonly crossSubdomainCookie?: boolean
	/**
	 * Explicit cookie `Domain=` (without the leading dot), e.g. `"example.com"`.
	 * Defaults to the broadest domain the browser accepts, discovered by probing.
	 * `""` forces a host-only cookie.
	 */
	readonly cookieDomain?: string
	/** Send `identify()`'s email through to the warehouse. Default true. */
	readonly captureUserEmail?: boolean
	/** Treat `navigator.doNotTrack` like GPC. Default false. */
	readonly respectDoNotTrack?: boolean
	/**
	 * Rewrite every URL before it leaves the page (session entry/exit URLs,
	 * event rows, network events, replay meta events, span attributes). Runs
	 * after the built-in redaction of credential-shaped query and fragment
	 * parameters (`token`, `code`, `access_token`, …).
	 */
	readonly sanitizeUrl?: (url: string) => string
}

type ConsentListener = (allowed: boolean) => void

interface ConsentState {
	requireConsent: boolean
	granted: boolean
	respectDoNotTrack: boolean
	allowedSince: number
	/** Last withdrawal on this page; the only copy in memory-only mode. */
	revokedAt: number
	/** Some SDK has called `configurePrivacy`, so a missing gate is deliberate. */
	configured: boolean
	/** `setConsent(false)` arrived before any gate existed, to be applied when one does. */
	deniedBeforeGate: boolean
	readonly listeners: Set<ConsentListener>
}

/**
 * Consent lives on `globalThis`, for the same reason the event sink does
 * (`events/events-sink.ts`): an app that bundles both `@maple-dev/browser` and the
 * Effect SDK gets **two copies** of this module, and per-copy state would mean
 * `setConsent(true)` on one never releases the other copy's exporters — or, the
 * other way round, one copy capturing while the other believes consent is
 * required. There is one user and one decision, so there is one state.
 */
const CONSENT_KEY = "__MAPLE_BROWSER_CONSENT__"

function consentState(): ConsentState {
	const owner = globalThis as Record<string, unknown>
	const existing = owner[CONSENT_KEY] as ConsentState | undefined
	if (existing) {
		// Created by an older SDK copy on the page, before the field existed.
		existing.revokedAt ||= 0
		existing.configured ||= false
		existing.deniedBeforeGate ||= false
		return existing
	}
	const fresh: ConsentState = {
		allowedSince: 0,
		configured: false,
		deniedBeforeGate: false,
		granted: false,
		listeners: new Set(),
		requireConsent: false,
		respectDoNotTrack: false,
		revokedAt: 0,
	}
	owner[CONSENT_KEY] = fresh
	return fresh
}

/** When consent was last withdrawn, on any page of this origin. Persisted: the grant time resets every load. */
const REVOKED_AT_KEY = "maple-consent-revoked-at"

function writeRevokedAt(at: number): void {
	consentState().revokedAt = at
	if (!mayUseStorage()) return
	try {
		localStorage.setItem(REVOKED_AT_KEY, String(at))
	} catch {}
}

/** Epoch ms of the last consent withdrawal on this origin, 0 if never. Data kept from before it must not be sent. */
export function consentRevokedAt(): number {
	const inMemory = consentState().revokedAt
	if (!mayUseStorage()) return inMemory
	try {
		return Math.max(inMemory, Number(localStorage.getItem(REVOKED_AT_KEY)) || 0)
	} catch {
		return inMemory
	}
}

/**
 * Withdraw consent for good: data kept from before now is never sent, and the
 * persistent visitor id and visit claim are deleted from every store.
 */
function revoke(): void {
	writeRevokedAt(Date.now())
	purgeVisitorId()
}

/**
 * How long a denial on a page that never granted waits before it purges.
 * Consent tools commonly set a default "denied" and then replay the stored
 * "granted" once loaded; purging at once would mint a new visitor every page.
 */
const DENIAL_SETTLE_MS = 10_000
let pendingRevoke: ReturnType<typeof setTimeout> | undefined

function cancelPendingRevoke(): void {
	if (pendingRevoke !== undefined) clearTimeout(pendingRevoke)
	pendingRevoke = undefined
}

/** A denial with no grant before it on this page: a withdrawal unless a grant follows soon. */
function revokeUnlessGranted(): void {
	if (pendingRevoke !== undefined) return
	pendingRevoke = setTimeout(() => {
		pendingRevoke = undefined
		if (!consentState().granted) revoke()
	}, DENIAL_SETTLE_MS)
}

let warnedAboutMissingGate = false

function updateEffectiveConsent(previous: boolean): void {
	const state = consentState()
	const allowed = hasConsent()
	if (allowed === previous) return
	state.allowedSince = allowed ? Date.now() : Number.POSITIVE_INFINITY
	for (const listener of state.listeners) {
		try {
			listener(allowed)
		} catch {
			// Telemetry controls must never throw into the host application or
			// prevent the remaining capture owners from observing the transition.
		}
	}
}

/**
 * Apply the host app's privacy config. Call before anything captures.
 *
 * Both SDKs call this at startup, and an app can init one of them without a
 * `privacy` block — so the gates only ever **tighten**. Letting the second
 * caller's absent option reset `requireConsent` back to false would silently
 * disable a gate the first caller asked for, and the resulting
 * denied→allowed transition would start capture on a user who never consented.
 * To genuinely relax a gate, reload without it.
 */
/** Returns the remover for its `sanitizeUrl`, so a shutdown leaves no closure behind. */
export function configurePrivacy(options: PrivacyOptions | undefined): () => void {
	const state = consentState()
	const previous = hasConsent()
	state.configured = true
	state.requireConsent = state.requireConsent || (options?.requireConsent ?? false)
	state.respectDoNotTrack = state.respectDoNotTrack || (options?.respectDoNotTrack ?? false)
	configurePersistence(options?.persistence)
	configureVisitorCookie({
		crossSubdomainCookie: options?.crossSubdomainCookie,
		cookieDomain: options?.cookieDomain,
	})
	if (options?.persistVisitorId === false) optOutOfVisitorId()
	const removeSanitizer = options?.sanitizeUrl ? addUrlSanitizer(options.sanitizeUrl) : () => {}
	// A consent tool that replayed "denied" before init: now that a gate exists,
	// that denial is a withdrawal.
	if (state.requireConsent && state.deniedBeforeGate && !state.granted) revokeUnlessGranted()
	state.deniedBeforeGate = false
	updateEffectiveConsent(previous)
	return removeSanitizer
}

/**
 * Record the user's consent decision. No-op unless `requireConsent` is set.
 *
 * Under the gate, every `false` is a withdrawal, including one replayed on a
 * fresh page load: the visitor id and data queued under an earlier grant must
 * not survive it. That one purges after a short settle, so a default "denied"
 * the consent tool replaces with "granted" does not reset the visitor.
 */
export function setConsent(nextGranted: boolean): void {
	const previous = hasConsent()
	const state = consentState()
	const wasGranted = state.granted
	state.granted = nextGranted
	if (nextGranted) {
		state.deniedBeforeGate = false
		cancelPendingRevoke()
	} else if (state.requireConsent) {
		if (wasGranted) {
			cancelPendingRevoke()
			revoke()
		} else revokeUnlessGranted()
	} else if (!state.configured) {
		state.deniedBeforeGate = true
	} else if (!warnedAboutMissingGate) {
		warnedAboutMissingGate = true
		console.warn(
			"[maple] setConsent(false) has no effect without privacy.requireConsent; capture continues.",
		)
	}
	updateEffectiveConsent(previous)
}

/** Whether capture may proceed at all. */
export function hasConsent(): boolean {
	const state = consentState()
	return !state.requireConsent || state.granted
}

/**
 * Subscribe to effective capture permission changes. The listener is invoked
 * only when capture actually transitions between allowed and denied; changing
 * the stored decision while `requireConsent` is off is deliberately silent.
 */
export function onConsentChange(listener: ConsentListener): () => void {
	const { listeners } = consentState()
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/**
 * Earliest epoch-ms timestamp telemetry may export for the current grant.
 * `Infinity` means capture is denied. Exporters use this to discard anything
 * buffered before a late grant or across a revoke/re-grant cycle.
 */
export function consentAllowedSince(): number {
	return hasConsent() ? consentState().allowedSince : Number.POSITIVE_INFINITY
}

/**
 * Whether a *persistent* identifier may be stored. Separate from `hasConsent`
 * because GPC/DNT suppress the cross-session id without suppressing capture.
 */
export function mayPersistIdentifier(): boolean {
	if (!hasConsent() || !mayUseStorage()) return false
	if (typeof navigator === "undefined") return true
	const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
	if (nav.globalPrivacyControl === true) return false
	if (consentState().respectDoNotTrack && nav.doNotTrack === "1") return false
	return true
}

/** Test seam. */
export function resetConsentForTests(): void {
	cancelPendingRevoke()
	const state = consentState()
	state.requireConsent = false
	state.granted = false
	state.respectDoNotTrack = false
	state.allowedSince = 0
	state.revokedAt = 0
	state.configured = false
	state.deniedBeforeGate = false
	state.listeners.clear()
	resetUrlSanitizersForTests()
	resetPersistenceForTests()
	// The visitor opt-out and cookie scope only tighten too, from `configurePrivacy`.
	resetVisitorCacheForTests()
}
