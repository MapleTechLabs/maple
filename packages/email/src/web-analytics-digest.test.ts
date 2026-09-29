import { describe, expect, it } from "vitest"
import { quietWebAnalyticsDigestProps, webAnalyticsDigestProps } from "./samples"
import { renderWebAnalyticsDigest } from "./web-analytics-digest"
import { deriveWebAnalyticsHeadline, fmtDuration, hasWebAnalyticsContent } from "./web-analytics-digest-core"

describe("renderWebAnalyticsDigest", () => {
	it("fills every token and renders each section", () => {
		const html = renderWebAnalyticsDigest(webAnalyticsDigestProps)
		expect(html).not.toMatch(/\[\[#?[A-Za-z0-9_]+\]\]/)
		for (const text of ["Top pages", "Top sources", "AI traffic"]) {
			expect(html).toContain(text)
		}
		for (const text of ["ChatGPT", "GPTBot", "https://maple.dev/email/icons/chatgpt.png"]) {
			expect(html).toContain(text)
		}
	})

	it("says so when there is no AI traffic, and drops the crawler tile without the table", () => {
		const html = renderWebAnalyticsDigest(quietWebAnalyticsDigestProps)
		expect(html).not.toMatch(/\[\[#?[A-Za-z0-9_]+\]\]/)
		expect(html).toContain("No visits from AI assistants and no AI crawler fetches this week.")
		expect(html).not.toMatch(/>\s*Crawler fetches\s*</)
		expect(html).toContain("n/a")
	})

	it("escapes page paths", () => {
		const html = renderWebAnalyticsDigest({
			...webAnalyticsDigestProps,
			topPages: [{ icon: null, label: "/<script>", value: 10, share: 1 }],
		})
		expect(html).toContain("/&lt;script&gt;")
		expect(html).not.toContain("/<script>")
	})
})

describe("deriveWebAnalyticsHeadline", () => {
	it("leads the standout with AI referrals and puts the trend in the subject", () => {
		const { headline, standout, subject } = deriveWebAnalyticsHeadline(webAnalyticsDigestProps)
		expect(headline).toBe("12.5K visitors this week, up 18.2% on last week.")
		expect(standout).toBe("ChatGPT sent 410 visits.")
		expect(subject).toBe("Acme Corp · Web analytics · 12.5K visitors (↑ 18.2%)")
	})

	it("falls back to the top page and stays quiet about an unquantified trend", () => {
		const { headline, standout, subject } = deriveWebAnalyticsHeadline(quietWebAnalyticsDigestProps)
		expect(headline).toBe("84 visitors this week, about the same as last week.")
		expect(standout).toBe("Top page: / (150 views).")
		expect(subject).toBe("Tiny Blog · Web analytics · 84 visitors")
	})
})

describe("hasWebAnalyticsContent", () => {
	const noBrowserData = {
		...quietWebAnalyticsDigestProps,
		summary: {
			...quietWebAnalyticsDigestProps.summary,
			visitors: { value: 0, delta: { kind: "none" } },
			pageViews: { value: 0, delta: { kind: "none" } },
		},
	} satisfies typeof quietWebAnalyticsDigestProps

	it("is false without browser SDK data, even when AI crawlers hit the site", () => {
		// Crawler fetches are server spans: they exist without the browser SDK.
		expect(
			hasWebAnalyticsContent({
				...noBrowserData,
				ai: {
					referrals: { sessions: 0, delta: { kind: "none" }, byProduct: [] },
					crawlers: { requests: 5_000, delta: { kind: "new" }, byCrawler: [] },
				},
			}),
		).toBe(false)
	})

	it("is true once the browser SDK reports visits", () => {
		expect(hasWebAnalyticsContent(quietWebAnalyticsDigestProps)).toBe(true)
	})
})

describe("fmtDuration", () => {
	it("formats seconds, minutes and hours", () => {
		expect(fmtDuration(41_000)).toBe("41s")
		expect(fmtDuration(154_000)).toBe("2m 34s")
		expect(fmtDuration(120_000)).toBe("2m")
		expect(fmtDuration(3_900_000)).toBe("1h 5m")
	})
})
