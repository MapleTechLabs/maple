import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { canGoBack, trackVisit } from "../navigation"
import { describeStatus } from "../shell/ingest-status"
import { connectionOf, nextProbeDelayMs, nextServerState } from "./derive"
import { ProbeOutcome } from "./state"

const NOW = 1_800_000_000_000

describe("server status", () => {
	test("one refusal rechecks quickly and still reads as connecting; two is down", () => {
		const first = nextServerState(Option.none(), ProbeOutcome.Refused(), NOW)
		expect(nextProbeDelayMs(first)).toBe(1_000)
		expect(connectionOf(Option.some(first)).status).toBe("connecting")
		const second = nextServerState(Option.some(first), ProbeOutcome.Refused(), NOW + 1_000)
		expect(connectionOf(Option.some(second)).status).toBe("disconnected")
		expect(nextProbeDelayMs(second)).toBe(5_000)
	})

	test("a 4xx is this page being refused, a 5xx keeps the views", () => {
		const rejected = nextServerState(Option.none(), ProbeOutcome.Rejected({ status: 403, detail: "no" }), NOW)
		expect(connectionOf(Option.some(rejected)).status).toBe("rejected")
		const failing = nextServerState(Option.none(), ProbeOutcome.Rejected({ status: 500, detail: "x" }), NOW)
		expect(connectionOf(Option.some(failing)).status).toBe("connected")
		expect(describeStatus(Option.some(failing), "4318").label).toBe("Server error")
	})

	test("recent ingest reads as receiving, older as the last data age", () => {
		const live = nextServerState(Option.none(), ProbeOutcome.Ok({ lastIngestAtMs: NOW - 20_000 }), NOW)
		expect(describeStatus(Option.some(live), "4318").label).toBe("Receiving")
		const idle = nextServerState(Option.none(), ProbeOutcome.Ok({ lastIngestAtMs: NOW - 3 * 60_000 }), NOW)
		expect(describeStatus(Option.some(idle), "4318").label).toBe("Last data 3m ago")
	})
})

describe("in-app history", () => {
	test("a push adds, a return pops, a replace rewrites the last entry", () => {
		const pushed = trackVisit(["/traces"], "/traces/a", false)
		expect(canGoBack(pushed)).toBe(true)
		expect(trackVisit(pushed, "/traces", false)).toEqual(["/traces"])
		expect(trackVisit(["/traces"], "/traces?errors=1", true)).toEqual(["/traces?errors=1"])
	})
})
