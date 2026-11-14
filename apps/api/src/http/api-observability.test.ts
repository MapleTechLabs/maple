import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { HttpMiddleware, HttpServerRequest, UrlParams } from "effect/http"
import { ApiObservabilityLive } from "./api-observability"

const tracedFor = (url: string, method = "GET") =>
	Effect.gen(function* () {
		const disabled = yield* HttpMiddleware.TracerDisabledWhen
		return !disabled(HttpServerRequest.fromWeb(new Request(`https://api.maple.dev${url}`, { method })))
	}).pipe(Effect.provide(ApiObservabilityLive), Effect.runSync)

describe("ApiObservabilityLive", () => {
	it("records no server span for a heartbeat ping, whose path carries the token", () => {
		expect(tracedFor("/hb/abc123secret")).toBe(false)
		expect(tracedFor("/hb/abc123secret/fail", "POST")).toBe(false)
	})

	// The audit log is filtered by a member's email. The span of that request is kept for weeks
	// and read by people who cannot open the audit log.
	it("keeps an audit actor filter out of the URL a server span records", () => {
		const recorded = Effect.gen(function* () {
			const names = yield* UrlParams.CurrentRedactedNames
			return UrlParams.redactUrl(
				"https://api.maple.dev/internal/audit-trail/events?actor=ada%40acme.test&category=membership&sig=abc",
				names,
			)
		}).pipe(Effect.provide(ApiObservabilityLive), Effect.runSync)

		expect(recorded).not.toContain("ada")
		expect(recorded).toContain("category=membership")
		// Effect's own defaults still apply.
		expect(recorded).not.toContain("abc")
	})

	it("still traces ordinary API routes", () => {
		expect(tracedFor("/api/v2/uptime_monitors")).toBe(true)
		expect(tracedFor("/hbx")).toBe(true)
	})
})
