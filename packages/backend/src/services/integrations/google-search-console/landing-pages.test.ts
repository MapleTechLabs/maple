import { describe, expect, it } from "vitest"
import { Option, Array as Arr } from "effect"
import {
	entryPathsFor,
	landingKeyOfUrl,
	mergeLandingPages,
	normalizePath,
	topSearchPages,
	type EntryPageRow,
	type SearchPageRow,
} from "./landing-pages"

const page = (url: string, clicks: number, impressions = clicks * 10, position = 5): SearchPageRow => ({
	page: url,
	clicks,
	impressions,
	positionSum: position * impressions,
})

const entry = (
	host: string,
	entryPath: string,
	sessions: number,
	bounced = 0,
	identified = sessions,
): EntryPageRow => ({ host, entryPath, sessions, bouncedSessions: bounced, identifiedSessions: identified })

describe("landing page keys", () => {
	it("drops the query string, fragment and trailing slash but keeps the root", () => {
		expect(normalizePath("/docs/?ref=x#top")).toBe("/docs")
		expect(normalizePath("/")).toBe("/")
		expect(normalizePath("")).toBe("/")
		expect(Option.getOrNull(landingKeyOfUrl("HTTPS://WWW.Acme.dev"))).toEqual({
			host: "www.acme.dev",
			path: "/",
		})
		expect(Option.isNone(landingKeyOfUrl("sc-domain:acme.dev"))).toBe(true)
	})

	it("asks web analytics for each path with and without its slash", () => {
		expect(entryPathsFor([page("https://acme.dev/", 1), page("https://acme.dev/docs/", 1)])).toEqual([
			"/",
			"/docs",
			"/docs/",
		])
	})
})

describe("mergeLandingPages", () => {
	it("joins sessions on host and path, whatever the slash or scheme", () => {
		const rows = mergeLandingPages({
			pages: [page("https://acme.dev/docs/", 30, 600, 4), page("http://acme.dev/docs", 10, 400, 9)],
			entries: [entry("acme.dev", "/docs", 50, 10, 40), entry("ACME.dev", "/docs/", 5, 0, 0)],
			conversions: [entry("acme.dev", "/docs", 7)],
		})
		expect(rows).toEqual([
			{
				page: "https://acme.dev/docs/",
				host: "acme.dev",
				path: "/docs",
				clicks: 40,
				impressions: 1000,
				ctr: 0.04,
				position: (4 * 600 + 9 * 400) / 1000,
				sessions: 55,
				bounceRate: 10 / 40,
				conversions: 7,
			},
		])
	})

	it("keeps hosts apart and reports unknowns as null, not zero", () => {
		const rows = mergeLandingPages({
			pages: [page("https://acme.dev/pricing", 5), page("https://www.acme.dev/pricing", 20)],
			entries: [entry("www.acme.dev", "/pricing", 12, 0, 0)],
			conversions: null,
		})
		expect(
			Arr.map(rows, (row) => [row.host, row.clicks, row.sessions, row.bounceRate, row.conversions]),
		).toEqual([
			["www.acme.dev", 20, 12, null, null],
			["acme.dev", 5, 0, null, null],
		])
	})
})

describe("landing page order", () => {
	it("orders by the requested metric, so a cut keeps the right pages", () => {
		const rows = mergeLandingPages({
			pages: [page("https://acme.dev/a", 50, 100), page("https://acme.dev/b", 5, 9000)],
			entries: [],
			conversions: null,
			sortBy: "impressions",
		})
		expect(Arr.map(rows, (row) => row.path)).toEqual(["/b", "/a"])
	})
})

describe("topSearchPages", () => {
	const pages = [
		page("https://maple.dev/", 10, 200, 3),
		page("http://maple.dev/", 6, 100, 6),
		page("https://maple.dev/compare", 4, 50, 8),
		page("https://maple.dev/compare/", 2, 50, 4),
		page("https://maple.dev/docs", 5, 400, 12),
	]

	it("merges scheme and trailing-slash duplicates and recomputes ctr and position", () => {
		expect(topSearchPages(pages, { limit: 10 })).toEqual([
			{
				page: "https://maple.dev/",
				host: "maple.dev",
				path: "/",
				clicks: 16,
				impressions: 300,
				ctr: 16 / 300,
				position: (3 * 200 + 6 * 100) / 300,
			},
			{
				page: "https://maple.dev/compare",
				host: "maple.dev",
				path: "/compare",
				clicks: 6,
				impressions: 100,
				ctr: 0.06,
				position: 6,
			},
			{
				page: "https://maple.dev/docs",
				host: "maple.dev",
				path: "/docs",
				clicks: 5,
				impressions: 400,
				ctr: 5 / 400,
				position: 12,
			},
		])
	})

	it("sorts the merged rows as asked and cuts to the limit after merging", () => {
		expect(Arr.map(topSearchPages(pages, { sortBy: "position", limit: 2 }), (row) => row.path)).toEqual([
			"/",
			"/compare",
		])
		expect(
			Arr.map(topSearchPages(pages, { sortBy: "impressions", limit: 2 }), (row) => row.path),
		).toEqual(["/docs", "/"])
	})
})
