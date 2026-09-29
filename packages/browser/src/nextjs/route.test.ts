import { describe, expect, it } from "vitest"
import { routeTemplate, urlKey } from "./route"

describe("routeTemplate", () => {
	it.each([
		["a dynamic segment", "/projects/8f2a", { id: "8f2a" }, "/projects/[id]"],
		["a static route", "/settings/billing", {}, "/settings/billing"],
		["the root", "/", {}, "/"],
		["several params", "/orgs/acme/projects/1", { org: "acme", id: "1" }, "/orgs/[org]/projects/[id]"],
		["a param equal to a static segment", "/projects/projects", { id: "projects" }, "/projects/[id]"],
		["two params with one value", "/a/1/b/1", { x: "1", y: "1" }, "/a/[x]/b/[y]"],
		["a catch-all", "/docs/guides/setup", { slug: ["guides", "setup"] }, "/docs/[...slug]"],
		[
			"a catch-all after a param",
			"/acme/docs/a/b",
			{ org: "acme", slug: ["a", "b"] },
			"/[org]/docs/[...slug]",
		],
		[
			"a one-segment catch-all equal to the static segment",
			"/shop/shop",
			{ slug: ["shop"] },
			"/shop/[...slug]",
		],
		["an empty optional catch-all", "/docs", { slug: undefined }, "/docs"],
		["an optional catch-all with no segments", "/docs", { slug: [] }, "/docs"],
		["a percent-encoded path", "/projects/caf%C3%A9", { id: "café" }, "/projects/[id]"],
		["an encoded slash", "/files/a%2Fb", { name: "a/b" }, "/files/[name]"],
		["a decoded path", "/projects/café", { id: "café" }, "/projects/[id]"],
		["a partly encoded path", "/users/a%20b@x.com", { email: "a b@x.com" }, "/users/[email]"],
		["a malformed escape", "/files/100%", { name: "100%" }, "/files/[name]"],
		["a trailing slash", "/projects/1/", { id: "1" }, "/projects/[id]/"],
		["a param the path doesn't contain", "/projects/1", { id: "1", tab: "members" }, "/projects/[id]"],
	])("handles %s", (_, pathname, params, expected) => {
		expect(routeTemplate(pathname, params)).toBe(expected)
	})
})

describe("urlKey", () => {
	it("ignores the hash and a bare ?", () => {
		expect(urlKey("/a", "")).toBe(urlKey("/a", "?"))
		expect(urlKey(new URL("https://x.test/a#top").pathname, new URL("https://x.test/a#top").search)).toBe(
			urlKey("/a", ""),
		)
	})

	it("tells paths and queries apart", () => {
		expect(urlKey("/a", "?tab=1")).not.toBe(urlKey("/a", "?tab=2"))
		expect(urlKey("/a", "")).not.toBe(urlKey("/b", ""))
		// `useSearchParams().toString()` has no `?`, `URL.search` does
		expect(urlKey("/a", "tab=1")).toBe(urlKey("/a", "?tab=1"))
	})
})
