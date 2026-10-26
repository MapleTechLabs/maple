import { assert, describe, it } from "@effect/vitest"
import type { HeartbeatWatch } from "./UptimeAlertSource"
import { isHeartbeatOverdue } from "./UptimeAlertSource"

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
