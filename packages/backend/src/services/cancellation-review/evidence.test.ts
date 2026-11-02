import { DateTime, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { auditEntryOf, digestSession, stripeFeedbackOf } from "./evidence"

const DAY_S = 86_400
const CANCELLED_S = 1_760_000_000
const feedback = (response: unknown) => Effect.runSync(stripeFeedbackOf(response, CANCELLED_S * 1000))

describe("stripeFeedbackOf", () => {
	it("reads the survey of the subscription cancelled at the reviewed time", () => {
		expect(
			feedback({
				data: [
					{
						created: 1,
						canceledAt: null,
						cancellationDetails: { feedback: "unused", comment: null },
					},
					{
						created: 2,
						canceledAt: CANCELLED_S + 60,
						cancellationDetails: {
							feedback: "too_expensive",
							comment: "  Bill doubled, mail me at a@b.co  ",
						},
					},
				],
			}),
		).toEqual({ feedback: "too_expensive", comment: "Bill doubled, mail me at [email]" })
	})

	it("never quotes an earlier cancellation, even when this one skipped the survey", () => {
		expect(
			feedback({
				data: [
					{
						created: 1,
						canceledAt: CANCELLED_S - 90 * DAY_S,
						cancellationDetails: { feedback: "switched_service", comment: "Datadog" },
					},
					{
						created: 2,
						canceledAt: CANCELLED_S,
						cancellationDetails: { feedback: null, comment: "" },
					},
				],
			}),
		).toEqual({ feedback: null, comment: null })
	})

	it("takes the cancellation closest to the reviewed one when two fall in the window", () => {
		expect(
			feedback({
				data: [
					{
						created: 1,
						canceledAt: CANCELLED_S + DAY_S,
						cancellationDetails: { feedback: "unused", comment: null },
					},
					{
						created: 2,
						canceledAt: CANCELLED_S + 30,
						cancellationDetails: { feedback: "missing_features", comment: null },
					},
				],
			}),
		).toEqual({ feedback: "missing_features", comment: null })
	})

	it("drops an address the length cut splits rather than quoting half of it", () => {
		const comment = `${"y".repeat(995)} ada@acme.io`
		const result = feedback({
			data: [
				{
					created: 1,
					canceledAt: CANCELLED_S,
					cancellationDetails: { feedback: null, comment },
				},
			],
		})
		expect(result.comment).not.toContain("ada")
	})

	it("fails on a body it cannot read, so the report says Stripe was not read", () => {
		expect(Exit.isFailure(Effect.runSyncExit(stripeFeedbackOf({ error: "nope" }, 0)))).toBe(true)
	})
})

describe("digestSession", () => {
	const row = {
		sessionId: "s_1",
		startTime: DateTime.makeUnsafe("2026-10-06T10:00:00Z"),
		durationMs: 90_000,
		quality: "engaged",
		pageViews: 4,
		clickCount: 12,
	}
	const event = (
		type: string,
		fields: Partial<{ url: string; message: string; netUrl: string; netStatus: number }>,
	) => ({
		type,
		url: "",
		message: "",
		netMethod: "POST",
		netUrl: "",
		netStatus: 0,
		...fields,
	})

	it("lists the pages in order, a reload or query change on the same page once", () => {
		const pages = [
			"https://app.maple.dev/traces",
			"https://app.maple.dev/traces?service=api",
			"https://app.maple.dev/billing",
			"https://app.maple.dev/traces",
		].map((url) => event("navigation", { url }))
		const digest = digestSession(Date.parse("2026-10-08T09:00:00Z"), row, pages, [])
		expect(digest.pages).toEqual(["/traces", "/billing", "/traces"])
		expect(digest.startedAt).toBe("2026-10-06T10:00:00.000Z")
		// Two days less an hour before: whole days, toward the cancellation.
		expect(digest.daysBeforeCancel).toBe(1)
	})

	it("names each distinct problem once: errors by message, failed requests by path and status", () => {
		const problems = [
			event("error", { message: "Boom for ada@acme.test" }),
			event("error", { message: "Boom for ada@acme.test" }),
			// Redacted before it is cut, so an address at the cut never half-survives.
			event("error", { message: `${"go ".repeat(63)}ada@acme.test` }),
			event("network", { netUrl: "https://api.maple.dev/v1/keys?token=secret", netStatus: 403 }),
			// Maple's own app, not the customer's: never shown as their problem.
			event("console", {
				message: "[MapleClientSDK] traces flush failed; cooldown 60s: TypeError: Load failed",
			}),
			event("network", { netUrl: "https://api.maple.dev/api/sync/shape?table=x", netStatus: 409 }),
		]
		expect(digestSession(0, row, [], problems).problems).toEqual([
			"Boom for [email]",
			`${"go ".repeat(63)}[email]`,
			"POST /v1/keys failed with 403",
		])
	})
})

describe("audit entries", () => {
	const entry = (action: string) => ({
		action,
		actorType: "user",
		outcome: "allowed",
		occurredAt: new Date("2026-10-06T10:00:00Z"),
	})

	it("names the actor's kind, never the person", () => {
		expect(auditEntryOf(Date.parse("2026-10-09T10:00:00Z"), entry("dashboard.deleted"))).toEqual({
			at: "2026-10-06T10:00:00.000Z",
			daysBeforeCancel: 3,
			action: "dashboard.deleted",
			actor: "user",
			outcome: "allowed",
		})
	})
})
