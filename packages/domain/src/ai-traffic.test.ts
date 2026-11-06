import { describe, expect, it } from "vitest"
import { AI_CRAWLERS, AI_PRODUCTS, aiProductById } from "./ai-traffic"
import { Array as Arr, String as Str } from "effect"

describe("AI traffic catalog", () => {
	it("never lists a crawler token inside another", () => {
		// multiSearchFirstIndex picks the leftmost match, so an overlapping pair
		// would file one crawler's fetches under the other.
		const tokens = Arr.map(AI_CRAWLERS, (crawler) => Str.toLowerCase(crawler.token))
		for (const token of tokens) {
			expect(Arr.filter(tokens, (other) => other !== token && Str.includes(token)(other))).toEqual([])
		}
	})

	it("points every crawler at a known product, and names are unique", () => {
		for (const crawler of AI_CRAWLERS) expect(aiProductById(crawler.product)).toBeDefined()
		const names = Arr.map(AI_CRAWLERS, (crawler) => crawler.name)
		expect(new Set(names).size).toBe(names.length)
	})

	it("keeps referrer hosts unique across products and free of www.", () => {
		const hosts = Arr.flatMap(AI_PRODUCTS, (product) => product.referrerHosts)
		expect(new Set(hosts).size).toBe(hosts.length)
		expect(Arr.filter(hosts, (host) => Str.startsWith("www.")(host))).toEqual([])
	})
})
