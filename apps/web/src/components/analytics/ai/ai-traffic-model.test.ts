import { describe, expect, it } from "vitest"

import {
	rankReferrals,
	sparkBucketSeconds,
	summarizeCrawls,
	summarizeReferrals,
	totalReferrals,
} from "./ai-traffic-model"

const WEEK = { startTime: "2026-09-19 00:00:00", endTime: "2026-09-26 00:00:00" }

describe("sparkBucketSeconds", () => {
	it("picks the narrowest step that keeps the bars to about a month of days", () => {
		expect(sparkBucketSeconds("2026-09-25 00:00:00", "2026-09-26 00:00:00")).toBe(3600)
		expect(sparkBucketSeconds(WEEK.startTime, WEEK.endTime)).toBe(6 * 3600)
		expect(sparkBucketSeconds("2026-08-27 00:00:00", "2026-09-26 00:00:00")).toBe(86_400)
	})
})

describe("summarizeReferrals", () => {
	it("zero-fills every bucket so sparse referrals do not read as steady traffic", () => {
		const summaries = summarizeReferrals(
			[
				{ bucket: "2026-09-20 00:00:00", product: "chatgpt", sessions: 2 },
				{ bucket: "2026-09-24 00:00:00.000000000", product: "chatgpt", sessions: 3 },
				{ bucket: "2026-09-24 00:00:00", product: "claude", sessions: 1 },
			],
			{ ...WEEK, bucketSeconds: 86_400 },
		)
		const chatgpt = summaries.get("chatgpt")
		expect(chatgpt?.visits).toBe(5)
		expect(chatgpt?.spark).toEqual([0, 2, 0, 0, 0, 3, 0, 0])
		expect(summaries.get("claude")?.spark.length).toBe(8)
	})
})

describe("rankReferrals", () => {
	it("orders by visits and reports the change in share in points, or new", () => {
		const current = summarizeReferrals(
			[
				{ bucket: "2026-09-20 00:00:00", product: "chatgpt", sessions: 6 },
				{ bucket: "2026-09-20 00:00:00", product: "perplexity", sessions: 2 },
				{ bucket: "2026-09-21 00:00:00", product: "claude", sessions: 2 },
			],
			{ ...WEEK, bucketSeconds: 86_400 },
		)
		const previous = totalReferrals([
			{ bucket: "2026-09-13 00:00:00", product: "chatgpt", sessions: 5 },
			{ bucket: "2026-09-13 00:00:00", product: "perplexity", sessions: 5 },
		])
		const ranks = rankReferrals(current, previous)
		expect(ranks.map((rank) => rank.product.id)).toEqual(["chatgpt", "perplexity", "claude"])
		expect(ranks[0]?.share).toBeCloseTo(0.6)
		expect(ranks[0]?.shareDeltaPoints).toBeCloseTo(10)
		expect(ranks[1]?.shareDeltaPoints).toBeCloseTo(-30)
		expect(ranks[2]?.shareDeltaPoints).toBeNull()
	})

	it("drops product ids the catalog does not know", () => {
		const current = summarizeReferrals(
			[{ bucket: "2026-09-20 00:00:00", product: "someday", sessions: 4 }],
			{
				...WEEK,
				bucketSeconds: 86_400,
			},
		)
		expect(rankReferrals(current, undefined)).toEqual([])
	})
})

describe("summarizeCrawls", () => {
	it("rolls crawlers up per product and orders purposes by pages served", () => {
		const crawls = summarizeCrawls([
			{
				crawler: "GPTBot",
				requests: 40,
				failedRequests: 30,
				pages: 8,
				lastSeen: "2026-09-25 10:00:00",
			},
			{
				crawler: "OAI-SearchBot",
				requests: 12,
				failedRequests: 0,
				pages: 12,
				lastSeen: "2026-09-25 12:00:00",
			},
			{
				crawler: "ChatGPT-User",
				requests: 5,
				failedRequests: 5,
				pages: 0,
				lastSeen: "2026-09-24 12:00:00",
			},
			{
				crawler: "Unknown-Bot",
				requests: 3,
				failedRequests: 0,
				pages: 3,
				lastSeen: "2026-09-24 12:00:00",
			},
		])
		const chatgpt = crawls.get("chatgpt")
		expect(chatgpt?.requests).toBe(57)
		expect(chatgpt?.failedRequests).toBe(35)
		// ChatGPT-User served nothing, so it has no purpose line.
		expect(chatgpt?.purposes.map((activity) => [activity.purpose, activity.pages])).toEqual([
			["search", 12],
			["training", 8],
		])
		expect(crawls.size).toBe(1)
	})
})
