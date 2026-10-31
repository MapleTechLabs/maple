import { afterEach, describe, expect, it, vi } from "vitest"
import {
	configurePrivacy,
	consentAllowedSince,
	consentRevokedAt,
	hasConsent,
	mayPersistIdentifier,
	onConsentChange,
	resetConsentForTests,
	setConsent,
} from "./consent"
import { getVisitorId, setVisitorTracking } from "./visitor"

/** A page whose visitor id from an earlier, consented load is still on disk. */
function installReturningVisitor(): { store: Map<string, string>; cookies: Map<string, string> } {
	const store = new Map<string, string>()
	const cookies = new Map<string, string>()
	const localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	}
	vi.stubGlobal("localStorage", localStorage)
	vi.stubGlobal("window", { localStorage })
	vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" })
	vi.stubGlobal("document", {
		get cookie(): string {
			return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
		},
		set cookie(raw: string) {
			const [pair = "", ...attrs] = raw.split(";").map((part) => part.trim())
			const eq = pair.indexOf("=")
			if (attrs.includes("max-age=0")) cookies.delete(pair.slice(0, eq))
			else cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
		},
	})
	const record = JSON.stringify({ id: "5f0c7d0e-2b1a-4c3d-8e9f-0a1b2c3d4e5f", mintedAt: Date.now() })
	store.set("maple.visitor", record)
	cookies.set("maple_visitor", encodeURIComponent(record))
	cookies.set("maple_visit", String(Date.now()))
	return { store, cookies }
}

afterEach(() => {
	resetConsentForTests()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("consent", () => {
	it("captures by default", () => {
		// Defaulting `requireConsent` to true would silently stop telemetry for
		// every existing install — an availability incident dressed as a privacy
		// win. Apps opt in.
		configurePrivacy(undefined)
		expect(hasConsent()).toBe(true)
		expect(mayPersistIdentifier()).toBe(true)
	})

	it("captures nothing until consent is granted when required", () => {
		configurePrivacy({ requireConsent: true })
		expect(hasConsent()).toBe(false)
		expect(mayPersistIdentifier()).toBe(false)

		setConsent(true)
		expect(hasConsent()).toBe(true)
		expect(mayPersistIdentifier()).toBe(true)

		setConsent(false)
		expect(hasConsent()).toBe(false)
	})

	it("persists when consent was withdrawn, so data kept from before can be dropped on a later page", () => {
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
		})
		// A page that starts without consent has not had it revoked.
		configurePrivacy({ requireConsent: true })
		expect(consentRevokedAt()).toBe(0)
		setConsent(true)
		expect(consentRevokedAt()).toBe(0)
		vi.useFakeTimers({ now: 5_000 })
		setConsent(false)
		expect(consentRevokedAt()).toBe(5_000)
	})

	it("notifies only effective transitions and advances the grant boundary", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-02T10:00:00Z"))
		const changes: boolean[] = []
		const stop = onConsentChange((allowed) => changes.push(allowed))

		configurePrivacy({ requireConsent: true })
		expect(changes).toEqual([false])
		expect(consentAllowedSince()).toBe(Number.POSITIVE_INFINITY)
		vi.advanceTimersByTime(1_000)
		setConsent(true)
		expect(changes).toEqual([false, true])
		expect(consentAllowedSince()).toBe(Date.now())
		setConsent(true)
		expect(changes).toEqual([false, true])

		stop()
		setConsent(false)
		expect(changes).toEqual([false, true])
	})

	it("re-stamps the allowed-since boundary across a revoke/re-grant cycle", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-02T12:00:00Z"))
		configurePrivacy({ requireConsent: true })
		setConsent(true)
		const firstGrant = consentAllowedSince()

		setConsent(false)
		expect(consentAllowedSince()).toBe(Number.POSITIVE_INFINITY)

		vi.advanceTimersByTime(60_000)
		setConsent(true)

		// Exporters discard anything older than this, so resurrecting the first
		// grant's timestamp would release everything buffered during the revoked
		// window — the case the doc comment on `consentAllowedSince` promises.
		expect(consentAllowedSince()).toBe(firstGrant + 60_000)
	})

	it("only ever tightens: a second configure without the option keeps the gate", () => {
		// Both SDKs call configurePrivacy at startup, and an app can init one of
		// them without a privacy block. Letting the absent option win would drop
		// the gate and — worse — the denied→allowed transition would start capture
		// on a user who never consented.
		const changes: boolean[] = []
		configurePrivacy({ requireConsent: true })
		onConsentChange((allowed) => changes.push(allowed))

		configurePrivacy(undefined)

		expect(hasConsent()).toBe(false)
		expect(changes).toEqual([])
	})

	it("shares one decision across every copy of the module on the page", () => {
		// An app bundling both SDKs gets two copies of this module; per-copy state
		// would mean one copy captures while the other is still gated.
		configurePrivacy({ requireConsent: true })
		setConsent(true)

		const shared = (globalThis as Record<string, unknown>)["__MAPLE_BROWSER_CONSENT__"]
		expect(shared).toMatchObject({ granted: true, requireConsent: true })
	})

	it("honors Global Privacy Control against the persistent id only", () => {
		vi.stubGlobal("navigator", { globalPrivacyControl: true })
		configurePrivacy(undefined)
		// GPC is legally recognized in several US states and maps exactly onto the
		// one cross-session identifier this SDK stores. The session itself — which
		// powers replay and error triage — is still captured, anonymously.
		expect(hasConsent()).toBe(true)
		expect(mayPersistIdentifier()).toBe(false)
	})

	it("ignores doNotTrack unless the app opts in", () => {
		vi.stubGlobal("navigator", { doNotTrack: "1" })

		// Deprecated and removed from Safari, so honoring it by default would
		// mostly drop data from users who never intended to opt out.
		configurePrivacy(undefined)
		expect(mayPersistIdentifier()).toBe(true)

		configurePrivacy({ respectDoNotTrack: true })
		expect(mayPersistIdentifier()).toBe(false)
	})

	it("memory-only mode keeps the identifier off and the revoke out of storage", () => {
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
		})
		vi.useFakeTimers({ now: 5_000 })
		configurePrivacy({ requireConsent: true, persistence: "memory" })
		setConsent(true)
		expect(hasConsent()).toBe(true)
		expect(mayPersistIdentifier()).toBe(false)

		setConsent(false)
		// Still known to this page, so data captured before the revoke is dropped.
		expect(consentRevokedAt()).toBe(5_000)
		expect(store.size).toBe(0)

		// A second SDK initialized without the option must not re-enable storage.
		configurePrivacy(undefined)
		setConsent(true)
		expect(mayPersistIdentifier()).toBe(false)
	})

	it("treats a denial replayed on a fresh page load as a withdrawal", () => {
		// Load 1 granted and stored a visitor id; on load 2 the consent tool
		// replays "denied" before anything was granted in this page's memory.
		const { store, cookies } = installReturningVisitor()
		vi.useFakeTimers({ now: 7_000 })
		configurePrivacy({ requireConsent: true })
		setConsent(false)
		// Settles first: the consent tool may still replace a default with a grant.
		expect(store.has("maple.visitor")).toBe(true)
		vi.advanceTimersByTime(10_000)

		expect(consentRevokedAt()).toBe(17_000)
		expect(store.has("maple.visitor")).toBe(false)
		expect(cookies.has("maple_visitor")).toBe(false)
		expect(cookies.has("maple_visit")).toBe(false)
	})

	it("keeps the visitor when a default denial is replaced by a grant", () => {
		const { store, cookies } = installReturningVisitor()
		vi.useFakeTimers({ now: 7_000 })
		configurePrivacy({ requireConsent: true })
		setConsent(false)
		vi.advanceTimersByTime(800)
		setConsent(true)
		vi.advanceTimersByTime(60_000)

		expect(consentRevokedAt()).toBe(0)
		expect(store.has("maple.visitor")).toBe(true)
		expect(cookies.has("maple_visitor")).toBe(true)
	})

	it("applies a denial that arrived before the gate was configured", () => {
		const { store } = installReturningVisitor()
		vi.useFakeTimers({ now: 7_000 })
		setConsent(false)
		configurePrivacy({ requireConsent: true })
		vi.advanceTimersByTime(10_000)

		expect(consentRevokedAt()).toBe(17_000)
		expect(store.has("maple.visitor")).toBe(false)
	})

	it("ignores setConsent(false) without a gate, and says so once", () => {
		const { store, cookies } = installReturningVisitor()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		configurePrivacy(undefined)
		setConsent(true)
		setConsent(false)
		setConsent(false)

		expect(hasConsent()).toBe(true)
		expect(consentRevokedAt()).toBe(0)
		expect(store.has("maple.visitor")).toBe(true)
		expect(cookies.has("maple_visitor")).toBe(true)
		expect(
			warn.mock.calls.filter(([message]) => String(message).includes("requireConsent")),
		).toHaveLength(1)
		warn.mockRestore()
	})

	it("keeps persistVisitorId: false from one SDK copy when another re-enables tracking", () => {
		const { store } = installReturningVisitor()
		configurePrivacy({ persistVisitorId: false })
		// What the second copy's `startRuntime` does with its own default config.
		setVisitorTracking(true)

		expect(getVisitorId()).toBeUndefined()
		expect(store.has("maple.visitor")).toBe(false)
	})

	it("does not assume a navigator exists", () => {
		configurePrivacy(undefined)
		expect(mayPersistIdentifier()).toBe(true)
	})
})
