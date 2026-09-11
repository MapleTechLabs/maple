import { describe, expect, it } from "vitest"

import {
	breadcrumbSessionId,
	buildBackToSessionsHref,
	resolveWindow,
	sessionLinkWindow,
	sessionRowId,
	sessionRowIdParts,
} from "@/lib/agent-sessions/session-window"

describe("resolveWindow", () => {
	it("pads a minute either side of the hints the list row carried", () => {
		const window = resolveWindow("2026-08-19 12:00:00.000000000", "2026-08-19 12:30:00.000000000")

		// The hints are the session's own bounds (`sessionLinkWindow` widens the
		// agent-only ones before they get here); the pad covers rounding and skew.
		expect(window).toEqual({ startTime: "2026-08-19 11:59:00", endTime: "2026-08-19 12:31:00" })
	})

	it("still narrows the read when only the start hint is present", () => {
		const window = resolveWindow("2026-08-19 12:00:00.000000000", undefined)

		expect(window).toEqual({ startTime: "2026-08-19 11:59:00", endTime: "2026-08-19 12:01:00" })
	})

	// An unusable `end` must not cost the reader a perfectly good `t`: dropping
	// the window entirely turns a cheap pruned read into the retention-wide one.
	it("keeps a valid start hint when the end hint is unparseable", () => {
		const window = resolveWindow("2026-08-19 12:00:00.000000000", "not-a-timestamp")

		expect(window).toEqual({ startTime: "2026-08-19 11:59:00", endTime: "2026-08-19 12:01:00" })
	})

	// No window at all, rather than a fabricated look-back: the endpoint resolves
	// the session by id, and the page writes the bounds it finds back into the URL.
	it("returns no window when there is no start hint", () => {
		expect(resolveWindow(undefined, undefined)).toBeUndefined()
	})

	it("treats an unparseable start hint as no hint at all", () => {
		expect(resolveWindow("not-a-timestamp", undefined)).toBeUndefined()
	})
})

describe("sessionLinkWindow", () => {
	const row = { startTime: "2026-08-19 12:00:00.000000000", endTime: "2026-08-19 12:30:00.000000000" }

	it("widens agent-only bounds by the hour the fan-out reads with", () => {
		expect(sessionLinkWindow(row)).toEqual({ t: "2026-08-19 11:00:00", end: "2026-08-19 13:30:00" })
	})

	it("passes the true extent through once the row's details landed", () => {
		expect(sessionLinkWindow({ ...row, hasDetails: true })).toEqual({ t: row.startTime, end: row.endTime })
	})
})

describe("breadcrumbSessionId", () => {
	it("leaves a short id alone", () => {
		expect(breadcrumbSessionId("sess-42")).toBe("sess-42")
	})

	it("elides a long id from the middle, keeping both ends", () => {
		expect(breadcrumbSessionId("wrun_01KZTEBCDEFGHIJKLMNOPQRSTUV")).toBe("wrun_01KZ…STUV")
	})
})

describe("sessionRowId", () => {
	// A framework's own id is the reader's vocabulary — it says what the session
	// is, whatever its length.
	it("leaves a vendor's own id whole", () => {
		expect(sessionRowId("wrun_01KZTEBCDEFGHIJKLMNOPQRSTUV")).toBe("wrun_01KZTEBCDEFGHIJKLMNOPQRSTUV")
	})

	it("cuts a synthesized id to the head of its trace id", () => {
		expect(sessionRowId("trace:7f3a4b5c6d7e8f901234567890abcdef")).toBe("trace:7f3a4b5c6d7e…")
	})

	// The prefix alone does not make an id Maple's, and a row must not claim a
	// trace that isn't one.
	it("leaves a prefixed id that is not a trace id alone", () => {
		expect(sessionRowId("trace:not-a-trace-id")).toBe("trace:not-a-trace-id")
	})
})

describe("sessionRowIdParts", () => {
	it("names a framework's key as a session, whole", () => {
		expect(sessionRowIdParts("wrun_01KZTEBCDEFGHIJKLMNOPQRSTUV")).toEqual({
			kind: "session",
			id: "wrun_01KZTEBCDEFGHIJKLMNOPQRSTUV",
			short: "wrun_01KZTEBCDEFGHIJKLMNOPQRSTUV",
		})
	})

	// The label says "Trace", so the prefix it stands in for is dropped from
	// both halves — the tooltip's id is the trace id a reader can search for.
	it("names a synthesized id as its trace", () => {
		expect(sessionRowIdParts("trace:7f3a4b5c6d7e8f901234567890abcdef")).toEqual({
			kind: "trace",
			id: "7f3a4b5c6d7e8f901234567890abcdef",
			short: "7f3a4b5c6d7e…",
		})
	})

	it("does not call a prefixed id that is not a trace id a trace", () => {
		expect(sessionRowIdParts("trace:not-a-trace-id").kind).toBe("session")
	})
})

describe("buildBackToSessionsHref", () => {
	it("keeps the list's own search and drops the detail page's params", () => {
		const href = buildBackToSessionsHref("?vendorIds=eve&t=2026-08-19&end=2026-08-19&trace=abc&span=def")

		expect(href).toBe("/agent-sessions?vendorIds=eve")
	})

	it("returns the bare list route when nothing survives", () => {
		expect(buildBackToSessionsHref("?t=2026-08-19&trace=abc")).toBe("/agent-sessions")
	})
})
