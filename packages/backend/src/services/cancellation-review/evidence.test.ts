import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { digestSession, stripeFeedbackOf } from "./evidence"

describe("stripeFeedbackOf", () => {
	it("reads the newest cancelled subscription the customer answered the survey on", () => {
		expect(
			stripeFeedbackOf({
				data: [
					{ created: 30, canceledAt: null, cancellationDetails: { feedback: null, comment: null } },
					{
						created: 10,
						canceledAt: 20,
						cancellationDetails: { feedback: "unused", comment: null },
					},
					{
						created: 20,
						canceledAt: 40,
						cancellationDetails: { feedback: "too_expensive", comment: "  Bill doubled  " },
					},
				],
			}),
		).toEqual({ feedback: "too_expensive", comment: "Bill doubled" })
	})

	it("is empty when nobody answered, or Stripe's list is not what it expects", () => {
		const empty = { feedback: null, comment: null }
		expect(
			stripeFeedbackOf({ data: [{ created: 1, canceledAt: 2, cancellationDetails: { comment: "" } }] }),
		).toEqual(empty)
		expect(stripeFeedbackOf({ error: "nope" })).toEqual(empty)
	})
})

describe("digestSession", () => {
	const row = {
		sessionId: "s_1",
		startTime: DateTime.makeUnsafe("2026-10-06T10:00:00Z"),
		durationMs: 90_000,
		userEmail: "a@acme.test",
		quality: "engaged",
		pageViews: 4,
		clickCount: 12,
		errorCount: 2,
	}

	it("lists the pages in order, a reload or query change on the same page once", () => {
		const digest = digestSession(row, [
			{ type: "navigation", url: "https://app.maple.dev/traces", message: "" },
			{ type: "navigation", url: "https://app.maple.dev/traces?service=api", message: "" },
			{ type: "navigation", url: "https://app.maple.dev/billing", message: "" },
			{ type: "navigation", url: "https://app.maple.dev/traces", message: "" },
		])
		expect(digest.pages).toEqual(["/traces", "/billing", "/traces"])
		expect(digest.startedAt).toBe("2026-10-06T10:00:00.000Z")
	})

	it("keeps each distinct error once", () => {
		const error = (message: string) => ({ type: "error", url: "", message })
		expect(digestSession(row, [error("Boom"), error("Boom"), error("Quota exceeded")]).problems).toEqual([
			"Boom",
			"Quota exceeded",
		])
	})
})
