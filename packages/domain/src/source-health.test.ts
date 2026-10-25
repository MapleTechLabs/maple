import { describe, expect, it } from "vitest"
import { type SourceHealthInput, sourceHealth, worstSourceStatus } from "./source-health"

const HOUR = 3_600_000
const MINUTE = 60_000
const now = 100 * HOUR

const source = (fields: Partial<SourceHealthInput> = {}): SourceHealthInput => ({
	platform: "nodejs",
	status: "active",
	lastUsedAt: null,
	lastRejectedAt: null,
	lastRejection: null,
	lastPollOkAt: null,
	lastPollError: null,
	disconnectedAt: null,
	pollResources: null,
	...fields,
})

describe("sourceHealth", () => {
	it.each([
		["active", null, "pending"],
		["active", now - HOUR, "healthy"],
		["active", now - 25 * HOUR, "stale"],
		["paused", now - HOUR, "paused"],
		["expired", now - HOUR, "disconnected"],
	] as const)("a push source %s with last data %s is %s", (status, lastUsedAt, expected) => {
		expect(sourceHealth(source({ status, lastUsedAt }), now).status).toBe(expected)
	})

	it("fails while a refusal is under 15 minutes old, even with data still accepted", () => {
		const refused = source({ lastUsedAt: now - MINUTE, lastRejection: "Rate limited" })
		expect(sourceHealth({ ...refused, lastRejectedAt: now - 5 * MINUTE }, now)).toEqual({
			status: "failing",
			lastDataAt: now - MINUTE,
			problem: "Rate limited",
		})
		expect(sourceHealth({ ...refused, lastRejectedAt: now - 20 * MINUTE }, now).status).toBe("healthy")
		expect(sourceHealth({ ...refused, status: "paused", lastRejectedAt: now - MINUTE }, now).status).toBe(
			"paused",
		)
	})

	it("judges a polled integration by its last good poll, not by data arriving", () => {
		const railway = source({ platform: "railway", lastUsedAt: now - MINUTE })
		expect(sourceHealth(railway, now).status).toBe("pending")
		expect(sourceHealth({ ...railway, lastPollOkAt: now - 5 * MINUTE }, now).status).toBe("healthy")
		expect(sourceHealth({ ...railway, lastPollOkAt: now - HOUR }, now)).toEqual({
			status: "stale",
			lastDataAt: now - MINUTE,
			problem: "No successful update in the last 30 minutes",
		})
	})

	it("fails on the poller's last error and counts the resources behind it", () => {
		expect(
			sourceHealth(
				source({
					platform: "cloudflare",
					lastPollOkAt: now - 5 * MINUTE,
					lastPollError: "1 of 3 zones failing",
					pollResources: { total: 3, unhealthy: 1 },
				}),
				now,
			),
		).toEqual({
			status: "failing",
			lastDataAt: now - 5 * MINUTE,
			problem: "1 of 3 zones failing",
			resources: { total: 3, unhealthy: 1 },
		})
	})

	it("is stale when the poll worked but some of its resources are behind", () => {
		expect(
			sourceHealth(
				source({
					platform: "railway",
					lastPollOkAt: now - MINUTE,
					pollResources: { total: 3, unhealthy: 1 },
				}),
				now,
			),
		).toMatchObject({ status: "stale", problem: "1 of 3 not up to date" })
	})

	it("waits out a source's own cadence when it has one", () => {
		const slow = source({ platform: "prometheus", lastPollOkAt: now - 20 * MINUTE })
		expect(sourceHealth(slow, now).status).toBe("stale")
		expect(sourceHealth({ ...slow, staleAfterMs: 50 * MINUTE }, now).status).toBe("healthy")
	})

	it("is disconnected while the grant is revoked, ahead of a pause", () => {
		const revoked = source({
			platform: "github",
			status: "paused",
			disconnectedAt: now - HOUR,
			lastPollError: "The GitHub installation is suspended",
		})
		expect(sourceHealth(revoked, now)).toMatchObject({
			status: "disconnected",
			problem: "The GitHub installation is suspended",
		})
	})
})

describe("sourceHealth for AWS", () => {
	const aws = (fields: Partial<SourceHealthInput> = {}) => source({ platform: "aws", ...fields })

	it("is not healthy on a good role check alone: only metric deliveries are data", () => {
		expect(sourceHealth(aws({ lastPollOkAt: now - MINUTE }), now)).toEqual({
			status: "pending",
			lastDataAt: null,
			problem: null,
		})
	})

	it("is healthy while deliveries arrive and stale once they stop", () => {
		const delivering = aws({ lastPollOkAt: now - MINUTE, lastUsedAt: now - 2 * MINUTE })
		expect(sourceHealth(delivering, now)).toEqual({
			status: "healthy",
			lastDataAt: now - 2 * MINUTE,
			problem: null,
		})
		expect(sourceHealth({ ...delivering, lastUsedAt: now - HOUR }, now)).toMatchObject({
			status: "stale",
			problem: "No data in the last 30 minutes",
		})
	})

	it("fails with what its integration reports, after a failed role check", () => {
		const refused = aws({ lastUsedAt: now - MINUTE, failing: "A delivery was refused" })
		expect(sourceHealth(refused, now)).toMatchObject({
			status: "failing",
			problem: "A delivery was refused",
		})
		expect(sourceHealth({ ...refused, lastPollError: "Role gone" }, now)).toMatchObject({
			status: "failing",
			problem: "Role gone",
		})
	})
})

describe("worstSourceStatus", () => {
	it("ranks disconnected over failing over stale, and nothing as healthy", () => {
		expect(worstSourceStatus(["healthy", "stale", "failing"])).toBe("failing")
		expect(worstSourceStatus(["paused", "disconnected"])).toBe("disconnected")
		expect(worstSourceStatus([])).toBe("healthy")
	})
})
