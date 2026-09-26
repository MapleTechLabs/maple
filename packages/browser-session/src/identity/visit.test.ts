import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetCookieScopeForTests } from "../platform/cookie"
import { claimVisit, clearVisitClaim, resetVisitClaimForTests, touchVisit } from "./visit"

const MINUTE = 60_000
const T0 = Date.UTC(2026, 4, 22, 12)

interface CookieEntry {
	value: string
	/** `""` = host-only. */
	domain: string
}

/**
 * A `document.cookie` stand-in shared by every origin in a test: a cookie set on
 * `example.com` has to reach `app.example.com`, which is the hop the claim
 * exists to deduplicate.
 */
function installCookies(jar: Map<string, CookieEntry>, hostname = "app.example.com"): void {
	vi.stubGlobal("location", { hostname, protocol: "https:" })
	vi.stubGlobal("document", {
		get cookie(): string {
			return [...jar].map(([name, entry]) => `${name}=${entry.value}`).join("; ")
		},
		set cookie(raw: string) {
			const [pair, ...attrs] = raw.split(";").map((part) => part.trim())
			const eq = pair?.indexOf("=") ?? -1
			if (!pair || eq < 0) return
			const name = pair.slice(0, eq)
			const domain = (attrs.find((a) => a.toLowerCase().startsWith("domain="))?.slice(7) ?? "").replace(
				/^\./,
				"",
			)
			if (attrs.some((a) => a.toLowerCase() === "max-age=0")) {
				jar.delete(name)
				return
			}
			jar.set(name, { value: pair.slice(eq + 1), domain })
		},
	})
}

/** A fresh, per-origin localStorage: the store that must *not* be what dedupes. */
function installStorage(options: { throwOnWrite?: boolean } = {}): Map<string, string> {
	const store = new Map<string, string>()
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				if (options.throwOnWrite) throw new Error("QuotaExceededError")
				store.set(key, value)
			},
			removeItem: (key: string) => store.delete(key),
		},
	})
	return store
}

/** A new page load on another tab or origin: fresh module state and localStorage. */
function newPageLoad(jar: Map<string, CookieEntry>, hostname?: string): void {
	resetVisitClaimForTests()
	resetCookieScopeForTests()
	installStorage()
	installCookies(jar, hostname)
}

describe("claimVisit", () => {
	let jar: Map<string, CookieEntry>

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		resetVisitClaimForTests()
		resetCookieScopeForTests()
		jar = new Map()
		installStorage()
		installCookies(jar)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("grants the first claim and refuses the rest of the window", () => {
		expect(claimVisit(T0, true)).toBe(true)
		expect(claimVisit(T0 + MINUTE, true)).toBe(false)
		expect(claimVisit(T0 + 29 * MINUTE, true)).toBe(false)
	})

	it("grants again after a full idle window", () => {
		expect(claimVisit(T0, true)).toBe(true)
		vi.setSystemTime(T0 + 30 * MINUTE)
		newPageLoad(jar)
		expect(claimVisit(T0 + 30 * MINUTE, true)).toBe(true)
	})

	it("keeps the visit open while activity continues", () => {
		expect(claimVisit(T0, true)).toBe(true)
		for (let minute = 10; minute <= 50; minute += 10) {
			vi.setSystemTime(T0 + minute * MINUTE)
			touchVisit(T0 + minute * MINUTE, true)
		}

		newPageLoad(jar)
		expect(claimVisit(T0 + 55 * MINUTE, true)).toBe(false)
	})

	it("does not reopen an expired visit from a touch", () => {
		expect(claimVisit(T0, true)).toBe(true)
		touchVisit(T0 + 31 * MINUTE, true)
		expect(claimVisit(T0 + 31 * MINUTE, true)).toBe(true)
	})

	it("refuses a second tab: fresh page state, same cookie jar", () => {
		expect(claimVisit(T0, true)).toBe(true)
		newPageLoad(jar)
		expect(claimVisit(T0 + MINUTE, true)).toBe(false)
	})

	it("refuses a second subdomain", () => {
		installCookies(jar, "example.com")
		expect(claimVisit(T0, true)).toBe(true)

		newPageLoad(jar, "app.example.com")
		expect(claimVisit(T0 + MINUTE, true)).toBe(false)
	})

	it("still deduplicates within a page load when localStorage writes throw", () => {
		installStorage({ throwOnWrite: true })
		expect(claimVisit(T0, true)).toBe(true)
		expect(claimVisit(T0 + MINUTE, true)).toBe(false)
	})

	it("writes nothing persistent when visitor tracking is off", () => {
		const storage = installStorage()
		expect(claimVisit(T0, false)).toBe(true)
		expect(claimVisit(T0 + MINUTE, false)).toBe(false)
		expect(storage.size).toBe(0)
		expect(jar.size).toBe(0)
	})

	it("clears every store on opt-out", () => {
		const storage = installStorage()
		claimVisit(T0, true)
		expect(jar.has("maple_visit")).toBe(true)

		clearVisitClaim()
		expect(jar.has("maple_visit")).toBe(false)
		expect(storage.size).toBe(0)
		expect(claimVisit(T0 + MINUTE, true)).toBe(true)
	})

	it("returns false outside a browser rather than billing a server render", () => {
		vi.unstubAllGlobals()
		expect(claimVisit(T0, true)).toBe(false)
	})
})
