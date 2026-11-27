import { describe, expect, it } from "vitest"
import { adClickCookie, withAdClickCookie } from "./ad-click"

const NOW = 1_764_000_000_000
const page = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe("adClickCookie", () => {
	it("keeps a gclid on maple.dev for a visitor outside Europe", () => {
		expect(
			adClickCookie(page("https://maple.dev/pricing?gclid=Cj0K_x-9&utm_source=google"), "US", NOW),
		).toBe(
			"maple_ad_click=gclid.Cj0K_x-9.1764000000000; Path=/; Max-Age=7776000; SameSite=Lax; Secure; Domain=maple.dev",
		)
		expect(adClickCookie(page("https://maple.dev/?wbraid=abc"), "CA", NOW)).toContain(
			"maple_ad_click=wbraid.abc.",
		)
	})

	it.each(["DE", "FR", "NO", "GB", "CH", "XX", undefined])(
		"keeps nothing for a visitor in %s",
		(country) => {
			expect(adClickCookie(page("https://maple.dev/?gclid=abc"), country, NOW)).toBeNull()
		},
	)

	it("keeps nothing under Global Privacy Control", () => {
		expect(adClickCookie(page("https://maple.dev/?gclid=abc", { "Sec-GPC": "1" }), "US", NOW)).toBeNull()
	})

	it("ignores a page with no click id or an id that is not one", () => {
		expect(adClickCookie(page("https://maple.dev/?utm_source=google"), "US", NOW)).toBeNull()
		expect(adClickCookie(page("https://maple.dev/?gclid=a%3Bb"), "US", NOW)).toBeNull()
	})

	it("keeps the first click time when the same ad URL is reloaded", () => {
		const reload = page("https://maple.dev/?gclid=abc", {
			Cookie: "maple_ad_click=gclid.abc.1700000000000",
		})
		expect(adClickCookie(reload, "US", NOW)).toBeNull()
		const newClick = page("https://maple.dev/?gclid=def", {
			Cookie: "maple_ad_click=gclid.abc.1700000000000",
		})
		expect(adClickCookie(newClick, "US", NOW)).toContain("maple_ad_click=gclid.def.")
	})

	it("is host-only off maple.dev", () => {
		expect(adClickCookie(page("https://landing.localhost/?gclid=abc"), "AU", NOW)).not.toContain(
			"Domain=",
		)
	})
})

describe("withAdClickCookie", () => {
	it("adds the cookie to a page and leaves a miss alone", () => {
		const request = page("https://maple.dev/?gclid=abc")
		const ok = withAdClickCookie(request, new Response("<html>"), "NZ", NOW)
		expect(ok.headers.get("Set-Cookie")).toContain("maple_ad_click=gclid.abc.")
		const missing = withAdClickCookie(request, new Response("no", { status: 404 }), "NZ", NOW)
		expect(missing.headers.get("Set-Cookie")).toBeNull()
	})
})
