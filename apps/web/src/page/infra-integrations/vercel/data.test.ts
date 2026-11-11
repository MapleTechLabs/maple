import { describe, expect, it } from "vitest"
import { vercelBucketSeconds } from "./data"

const window = (startTime: string, endTime: string) => ({ startTime, endTime })

describe("vercelBucketSeconds", () => {
	it("draws a short window from many points instead of the infra pages' five-minute floor", () => {
		expect(vercelBucketSeconds(window("2026-11-10 13:28:29", "2026-11-10 13:34:36"))).toBe(10)
		expect(vercelBucketSeconds(window("2026-11-10 13:00:00", "2026-11-10 14:00:00"))).toBe(30)
	})

	it("keeps 15-minute buckets for a day and caps at a day", () => {
		expect(vercelBucketSeconds(window("2026-11-10 00:00:00", "2026-11-11 00:00:00"))).toBe(900)
		expect(vercelBucketSeconds(window("2025-11-10 00:00:00", "2026-11-11 00:00:00"))).toBe(86_400)
	})
})
