import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	candidateDomains,
	cookieDomain,
	readRawCookie,
	resetCookieScopeForTests,
	tighterCookieDomain,
} from "./cookie"

afterEach(() => {
	resetCookieScopeForTests()
	vi.unstubAllGlobals()
})

const isLabelSuffix = (domain: string, host: string): boolean =>
	host === domain || host.endsWith(`.${domain}`)
const isIp = (domain: string): boolean => /^[\d.]+$/.test(domain)

const hostname = fc.oneof(
	fc.domain(),
	fc.ipV4(),
	fc.constantFrom("localhost", "example.com.", "a..b.com", "[::1]", ""),
	fc.string({ maxLength: 30 }),
)

describe("candidateDomains", () => {
	it("yields only multi-label, label-boundary suffixes of the host, never an IP", () => {
		fc.assert(
			fc.property(hostname, (host) => {
				for (const domain of candidateDomains(host)) {
					expect(isLabelSuffix(domain, host)).toBe(true)
					expect(domain.split(".").length).toBeGreaterThanOrEqual(2)
					expect(domain.split(".")).not.toContain("")
					expect(isIp(domain)).toBe(false)
				}
			}),
		)
	})
})

describe("tighterCookieDomain", () => {
	const domain = fc.oneof(fc.domain(), fc.constant(""))

	it("is idempotent and picks one of its inputs", () => {
		fc.assert(
			fc.property(fc.option(domain, { nil: undefined }), domain, (current, next) => {
				const tightened = tighterCookieDomain(current, next)
				expect([current, next]).toContain(tightened)
				expect(tighterCookieDomain(tightened, next)).toBe(tightened)
			}),
		)
	})

	it("never widens the scope", () => {
		fc.assert(
			fc.property(fc.option(domain, { nil: undefined }), domain, (current, next) => {
				const tightened = tighterCookieDomain(current, next)
				if (current === "" || next === "") expect(tightened).toBe("")
				// A strict parent of either side would be broader than what was asked for.
				for (const side of [current, next]) {
					if (side) expect(side.endsWith(`.${tightened}`) && tightened !== "").toBe(false)
				}
			}),
		)
	})
})

/** A cookie jar that refuses any `Domain=` with fewer than `minLabels` labels, like a public suffix. */
function installJar(host: string, minLabels: number): void {
	const jar = new Map<string, string>()
	vi.stubGlobal("location", { hostname: host, protocol: "https:" })
	vi.stubGlobal("document", {
		get cookie(): string {
			return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
		},
		set cookie(raw: string) {
			const [pair = "", ...attrs] = raw.split(";").map((part) => part.trim())
			const eq = pair.indexOf("=")
			const domain = attrs.find((attr) => attr.startsWith("domain="))?.slice(8) ?? ""
			if (domain && domain.split(".").length < minLabels) return
			if (attrs.includes("max-age=0")) jar.delete(pair.slice(0, eq))
			else jar.set(pair.slice(0, eq), pair.slice(eq + 1))
		},
	})
}

describe("cookieDomain", () => {
	it("is host-only or a label-boundary suffix of the host the browser accepted", () => {
		fc.assert(
			fc.property(hostname, fc.integer({ min: 1, max: 5 }), (host, minLabels) => {
				resetCookieScopeForTests()
				installJar(host, minLabels)
				const domain = cookieDomain()
				if (domain === "") return
				expect(isLabelSuffix(domain, host)).toBe(true)
				expect(domain.split(".").length).toBeGreaterThanOrEqual(Math.max(2, minLabels))
				expect(isIp(domain)).toBe(false)
			}),
		)
	})
})

describe("readRawCookie", () => {
	it("never throws on whatever document.cookie holds", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string({ unit: "binary" }),
					fc.constantFrom("maple_visit=%E0%A4%A", "maple_visit=%", "maple_visit"),
				),
				(cookie) => {
					vi.stubGlobal("document", { cookie })
					const value = readRawCookie("maple_visit")
					expect(value === undefined || typeof value === "string").toBe(true)
				},
			),
		)
	})

	it("reads a value back however it was percent-encoded", () => {
		fc.assert(
			fc.property(fc.string({ unit: "grapheme" }), (value) => {
				vi.stubGlobal("document", { cookie: `other=1; maple_visit=${encodeURIComponent(value)}` })
				expect(readRawCookie("maple_visit")).toBe(value)
			}),
		)
	})
})
