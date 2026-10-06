import { assert, describe, it } from "vitest"
import { timestampMs } from "./time"

// Run under `TZ=Europe/Berlin` too: `Date.parse` gives a different answer there for the zone-less rows.
describe("timestampMs", () => {
	it("reads a timestamp without a zone as UTC on any host", () => {
		const utc = Date.UTC(2026, 9, 7, 10, 0, 0)
		assert.strictEqual(timestampMs("2026-10-07 10:00:00"), utc)
		assert.strictEqual(timestampMs("2026-10-07T10:00:00"), utc)
		assert.strictEqual(timestampMs("2026-10-07T10:00:00Z"), utc)
		assert.strictEqual(timestampMs("2026-10-07T12:00:00+02:00"), utc)
		assert.strictEqual(timestampMs("Wed, 07 Oct 2026 10:00:00 GMT"), utc)
	})

	it("is NaN for anything that is not a timestamp", () => {
		assert.isNaN(timestampMs("not a time"))
	})
})
