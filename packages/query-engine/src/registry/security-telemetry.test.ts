import { describe, expect, it } from "vitest"
import { SecurityExposureRequest } from "@maple/domain/http"
import { scannerTimelineBucketSeconds } from "./queries"

const WINDOW = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-31 00:00:00" }

const request = (bucketSeconds?: number) =>
	bucketSeconds === undefined
		? new SecurityExposureRequest(WINDOW)
		: new SecurityExposureRequest({ ...WINDOW, bucketSeconds })

describe("scannerTimelineBucketSeconds", () => {
	it("keeps a bucket that fits the window", () => {
		expect(scannerTimelineBucketSeconds(request(3600))).toBe(3600)
		expect(scannerTimelineBucketSeconds(request())).toBe(3600)
	})

	it("widens a bucket too fine for the window so the newest buckets are not cut", () => {
		const bucket = scannerTimelineBucketSeconds(request(1))
		// Epoch-aligned buckets: an unaligned 30-day window touches at most ceil(window / bucket) + 1.
		expect(Math.ceil((30 * 86400) / bucket) + 1).toBeLessThanOrEqual(2000)
	})
})
