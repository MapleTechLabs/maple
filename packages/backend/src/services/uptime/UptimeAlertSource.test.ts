import { assert, describe, it } from "@effect/vitest"
import type { HeartbeatWatch, ProbeWatch } from "./UptimeAlertSource"
import { isHeartbeatOverdue, isProbeStale } from "./UptimeAlertSource"

const at = (iso: string) => Date.parse(iso)

// Every day at 09:00 in New York, which is 13:00 UTC in July (EDT).
const nineAmNewYork = (overrides: Partial<HeartbeatWatch> = {}): HeartbeatWatch => ({
	config: {
		_tag: "heartbeat",
		schedule: { _tag: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
		graceSeconds: 300,
	},
	enabled: true,
	status: "up",
	statusChangedAt: null,
	lastPingAt: at("2026-07-15T13:00:00Z"),
	createdAt: at("2026-07-01T00:00:00Z"),
	...overrides,
})

describe("isHeartbeatOverdue", () => {
	it("waits for the next run in the schedule's own time zone plus the grace", () => {
		// 09:00 UTC has passed, but 09:00 in New York has not: not overdue.
		assert.isFalse(isHeartbeatOverdue(nineAmNewYork(), at("2026-07-16T10:00:00Z")))
		// Next run 13:00 UTC, grace until 13:05.
		assert.isFalse(isHeartbeatOverdue(nineAmNewYork(), at("2026-07-16T13:04:00Z")))
		assert.isTrue(isHeartbeatOverdue(nineAmNewYork(), at("2026-07-16T13:06:00Z")))
	})

	it("treats a schedule with no next run as never overdue", () => {
		const never = nineAmNewYork({
			config: {
				_tag: "heartbeat",
				schedule: { _tag: "cron", expression: "0 0 30 2 *", timezone: "UTC" },
				graceSeconds: 0,
			},
		})
		assert.isFalse(isHeartbeatOverdue(never, at("2027-01-01T00:00:00Z")))
	})

	it("never marks a paused, already down or disabled heartbeat", () => {
		const late = at("2026-07-20T00:00:00Z")
		assert.isFalse(isHeartbeatOverdue(nineAmNewYork({ status: "paused" }), late))
		assert.isFalse(isHeartbeatOverdue(nineAmNewYork({ status: "down" }), late))
		assert.isFalse(isHeartbeatOverdue(nineAmNewYork({ enabled: false }), late))
	})

	it("gives a resumed heartbeat a full period from the resume", () => {
		const resumed = nineAmNewYork({
			status: "pending",
			lastPingAt: at("2026-07-01T13:00:00Z"),
			statusChangedAt: at("2026-07-20T14:00:00Z"),
		})
		assert.isFalse(isHeartbeatOverdue(resumed, at("2026-07-21T12:00:00Z")))
		assert.isTrue(isHeartbeatOverdue(resumed, at("2026-07-21T13:06:00Z")))
	})
})

const httpProbe = (overrides: Partial<ProbeWatch> = {}): ProbeWatch => ({
	config: {
		_tag: "http",
		url: "https://checkout.example.com/health",
		method: "GET",
		headers: {},
		assertions: [],
		timeoutMs: 5000,
	},
	intervalSeconds: 60,
	enabled: true,
	status: "up",
	statusChangedAt: null,
	lastCheckJson: { at: at("2026-07-15T13:00:00Z") },
	createdAt: at("2026-07-01T00:00:00Z"),
	...overrides,
})

describe("isProbeStale", () => {
	it("goes stale after three intervals without a check, and never before five minutes", () => {
		// A 60 s probe: three intervals are under the floor, so the floor decides.
		assert.isFalse(isProbeStale(httpProbe(), at("2026-07-15T13:05:00Z")))
		assert.isTrue(isProbeStale(httpProbe(), at("2026-07-15T13:05:01Z")))
		// A 10 min probe: three intervals decide.
		const slow = httpProbe({ intervalSeconds: 600 })
		assert.isFalse(isProbeStale(slow, at("2026-07-15T13:30:00Z")))
		assert.isTrue(isProbeStale(slow, at("2026-07-15T13:30:01Z")))
	})

	it("waits from the resume for a pending probe, and from creation for one never checked", () => {
		const resumed = httpProbe({ status: "pending", statusChangedAt: at("2026-07-20T14:00:00Z") })
		assert.isFalse(isProbeStale(resumed, at("2026-07-20T14:04:00Z")))
		assert.isTrue(isProbeStale(resumed, at("2026-07-20T14:06:00Z")))
		const fresh = httpProbe({ status: "pending", lastCheckJson: null })
		assert.isFalse(isProbeStale(fresh, at("2026-07-01T00:04:00Z")))
		assert.isTrue(isProbeStale(fresh, at("2026-07-01T00:06:00Z")))
	})

	it("never marks a down, paused or disabled probe, or a heartbeat", () => {
		const late = at("2026-07-20T00:00:00Z")
		assert.isFalse(isProbeStale(httpProbe({ status: "down" }), late))
		assert.isFalse(isProbeStale(httpProbe({ status: "paused" }), late))
		assert.isFalse(isProbeStale(httpProbe({ enabled: false }), late))
		assert.isFalse(isProbeStale(httpProbe({ config: nineAmNewYork().config }), late))
	})
})
