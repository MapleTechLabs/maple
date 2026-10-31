import { describe, expect, test } from "vitest"
import { alignServiceApiBucketSeconds } from "./service-api-buckets"

describe("alignServiceApiBucketSeconds", () => {
	test("sub-hour buckets round to whole minutes, at least one", () => {
		expect(alignServiceApiBucketSeconds(840)).toBe(840)
		expect(alignServiceApiBucketSeconds(870)).toBe(900)
		expect(alignServiceApiBucketSeconds(10)).toBe(60)
	})

	test("an hour or more rounds to whole hours, so the hourly rollup tiles each bucket", () => {
		expect(alignServiceApiBucketSeconds(5160)).toBe(3600)
		expect(alignServiceApiBucketSeconds(12_120)).toBe(10_800)
	})
})
