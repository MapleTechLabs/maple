import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-clickhouse"
import {
	webAnalyticsAiCrawledPagesQuery,
	webAnalyticsAiCrawlerFormatsQuery,
	webAnalyticsAiCrawlersQuery,
	webAnalyticsAiReferralsQuery,
} from "./web-analytics-ai"

const params = { orgId: "org_1", startTime: "2026-09-19 00:00:00", endTime: "2026-09-26 00:00:00" }

const oneLine = (sql: string): string => sql.replace(/\s+/g, " ")

describe("webAnalyticsAiReferralsQuery", () => {
	it("classifies by referrer first, then by UTM source", () => {
		const { sql, tenantScope } = compileUnsafe(
			webAnalyticsAiReferralsQuery({ bucketSeconds: 86_400 }),
			params,
		)
		expect(tenantScope).toBe("single-tenant")
		const flat = oneLine(sql)
		expect(flat).toContain("FROM session_replays")
		// `www.` is dropped before the exact host match.
		expect(flat).toContain(
			"transform(replaceRegexpOne(lower(ReferrerHost), '^www\\\\.', ''), ['chatgpt.com'",
		)
		expect(flat).toContain("transform(lower(UtmSource), ['chatgpt.com'")
		expect(flat).toMatch(/if\(transform\(replaceRegexpOne\(lower\(ReferrerHost\).* != '', transform/)
		expect(flat).toContain("GROUP BY bucket, product")
	})

	it("keeps only AI referrals, under the page's own filters", () => {
		const { sql } = compileUnsafe(
			webAnalyticsAiReferralsQuery({ traffic: "humans", country: "DE" }),
			params,
		)
		const flat = oneLine(sql)
		expect(flat).toMatch(
			/replaceRegexpOne\(lower\(ReferrerHost\), '\^www\\\\\.', ''\) IN \('chatgpt\.com'/,
		)
		expect(flat).toContain("OR lower(UtmSource) IN ('chatgpt.com'")
		expect(flat).toContain("Country = 'DE'")
		expect(flat).toContain("NOT (multiSearchAnyCaseInsensitive(UserAgent")
	})
})

describe("AI crawler queries", () => {
	it("counts requests by trace and pages only when the site served them", () => {
		const flat = oneLine(compileUnsafe(webAnalyticsAiCrawlersQuery({}), params).sql)
		expect(flat).toContain("FROM ai_crawler_requests")
		expect(flat).toContain("uniq(TraceId) AS requests")
		expect(flat).toContain("uniqIf(TraceId, NOT (HttpStatus < 400)) AS failedRequests")
		expect(flat).toContain("uniqIf(concat(Host, Path), HttpStatus < 400) AS pages")
		expect(flat).toContain("GROUP BY crawler")
	})

	it("narrows by host and path only", () => {
		const flat = oneLine(
			compileUnsafe(
				webAnalyticsAiCrawlerFormatsQuery({ host: "maple.dev", pagePath: "/llms.txt" }),
				params,
			).sql,
		)
		expect(flat).toContain("Host = 'maple.dev'")
		expect(flat).toContain("Path = '/llms.txt'")
		expect(flat).toContain("OrgId = 'org_1'")
	})

	it("classifies Markdown and llms.txt ahead of HTML", () => {
		const flat = oneLine(compileUnsafe(webAnalyticsAiCrawlerFormatsQuery({}), params).sql)
		const markdown = flat.indexOf("'markdown'")
		const llms = flat.indexOf("'llms'")
		const html = flat.indexOf("'html'")
		expect(markdown).toBeGreaterThan(-1)
		expect(markdown).toBeLessThan(llms)
		expect(llms).toBeLessThan(html)
		expect(flat).toContain("'other') AS format")
	})

	it("lists only served pages, most read first", () => {
		const flat = oneLine(compileUnsafe(webAnalyticsAiCrawledPagesQuery({ limit: 10 }), params).sql)
		expect(flat).toContain("AND HttpStatus < 400")
		expect(flat).toContain("ORDER BY requests DESC LIMIT 10")
	})
})
