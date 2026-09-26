import { describe, expect, it } from "vitest"
import { AI_CRAWLERS, AI_PRODUCTS, aiProductById } from "./ai-traffic"
import { AI_CRAWLER_NAME_SQL } from "./tinybird/ai-crawler-columns"

describe("AI traffic catalog", () => {
	it("never lists a crawler token inside another", () => {
		// multiSearchFirstIndex picks the leftmost match, so an overlapping pair
		// would file one crawler's fetches under the other.
		const tokens = AI_CRAWLERS.map((crawler) => crawler.token.toLowerCase())
		for (const token of tokens) {
			expect(tokens.filter((other) => other !== token && other.includes(token))).toEqual([])
		}
	})

	it("points every crawler at a known product, and names are unique", () => {
		for (const crawler of AI_CRAWLERS) expect(aiProductById(crawler.product)).toBeDefined()
		const names = AI_CRAWLERS.map((crawler) => crawler.name)
		expect(new Set(names).size).toBe(names.length)
	})

	it("keeps referrer hosts unique across products and free of www.", () => {
		const hosts = AI_PRODUCTS.flatMap((product) => product.referrerHosts)
		expect(new Set(hosts).size).toBe(hosts.length)
		expect(hosts.filter((host) => host.startsWith("www."))).toEqual([])
	})

	it("compiles the crawler name in catalog order", () => {
		expect(AI_CRAWLER_NAME_SQL).toContain(
			`arrayElement([${AI_CRAWLERS.map((crawler) => `'${crawler.name}'`).join(", ")}]`,
		)
	})
})
